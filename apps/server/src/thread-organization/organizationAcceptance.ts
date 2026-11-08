import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand, OrchestrationEvent } from "@bigbud/contracts";
import type { ThreadOrganizationNativeOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadOrganizationOperations } from "../persistence/Layers/ThreadOrganizationOperations.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { buildOrganizationFacts } from "./organizationFacts.build.ts";
import { makeOrganizationOwnerFacts } from "./organizationFacts.owners.ts";
import { readOrganizationRawFacts } from "./organizationFacts.query.ts";
import { organizationOwner } from "./organizationOwner.ts";
import { organizationPolicySettings } from "./organizationPolicy.ts";
import { validateOrganizationProposal } from "./organizationProposal.validation.ts";
import { withEventBase } from "../orchestration/deciderHelpers.ts";
import { organizationWithAge } from "../orchestration/threadOrganization.aging.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

const sameOrganizationOperation = (
  left: ThreadOrganizationNativeOperation,
  right: ThreadOrganizationNativeOperation,
) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(
    ([key, value]) => value === right[key as keyof ThreadOrganizationNativeOperation],
  );

type EventBase = Omit<OrchestrationEvent, "sequence">;
/** Called inside the serialized canonical command transaction. Never chooses candidates.
 * Prepared operation + receipt + resulting event are settled by the same transaction.
 */
export const makeOrganizationAcceptance = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const operations = yield* makeThreadOrganizationOperations;
  const owners = yield* makeOrganizationOwnerFacts;
  const settings = yield* ServerSettingsService;
  return (command: OrchestrationCommand, operation: ThreadOrganizationNativeOperation) =>
    Effect.gen(function* () {
      yield* sql`UPDATE thread_organization_runtime SET singleton = singleton WHERE singleton = 1`;
      const prepared = yield* operations.read(operation.operationId);
      if (!prepared || !sameOrganizationOperation(prepared.operation, operation))
        return yield* Effect.fail(new Error("unprepared organisation operation"));
      if (prepared.outcome) return [] as EventBase[];
      const owner = organizationOwner(sql);
      const nowMs = Date.now();
      const [raw] = yield* readOrganizationRawFacts(sql, operation.threadId);
      const currentSettings = yield* settings.getSettings;
      const [installation] = yield* sql<{
        classification: "new" | "existing";
      }>`SELECT classification FROM thread_organization_installation WHERE singleton = 1`;
      const fingerprint = organizationPolicySettings(
        currentSettings,
        installation?.classification ?? "existing",
      ).policyFingerprint;
      const live = raw
        ? buildOrganizationFacts(
            raw,
            yield* owners(raw.threadId),
            nowMs,
            currentSettings.inyosiraGraceMinutes * 60000,
          )
        : undefined;
      const [count] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM projection_threads WHERE organization_state = 'present' AND purpose = 'standard' AND archived_at IS NULL AND deleting_at IS NULL AND deleted_at IS NULL`;
      const [barrier] = yield* sql<{
        target_drain_not_before_ms: number | null;
      }>`SELECT target_drain_not_before_ms FROM thread_organization_runtime WHERE singleton = 1`;
      const livePolicy = owner?.policy.scheduling
        ? {
            ...owner.policy,
            scheduling: {
              ...owner.policy.scheduling,
              targetNotBeforeMs: Math.max(
                owner.policy.scheduling.targetNotBeforeMs ?? 0,
                barrier?.target_drain_not_before_ms ?? 0,
              ),
            },
          }
        : owner?.policy;
      const verdict =
        owner?.active &&
        nowMs >= owner.observedAtMs &&
        nowMs - owner.observedAtMs <= 75000 &&
        owner.policy.fingerprint === fingerprint &&
        command.type === "thread.organization.react" &&
        command.commandId === operation.operationId &&
        command.threadId === operation.threadId &&
        command.state === operation.destination
          ? validateOrganizationProposal({
              operation,
              owner,
              row: live?.row,
              policy: livePolicy!,
              nowMs,
              idleNotBeforeMs: owner.idleNotBeforeMs,
              presentCount: count?.count ?? 0,
            })
          : { status: "stale" as const };
      // Raw DB version alone cannot fence ephemeral terminal/engagement changes.
      const published = owner?.rows.get(operation.threadId);
      const unchanged = live && published && JSON.stringify(live.row) === JSON.stringify(published);
      if (verdict.status !== "valid" || !unchanged || !raw) {
        const outcome = verdict.status === "not-due" ? verdict : { status: "stale" as const };
        yield* operations.settle(operation.operationId, outcome);
        return [] as EventBase[];
      }
      const occurredAt = new Date(nowMs).toISOString();
      const current = {
        state: operation.from,
        revision: raw.organizationRevision,
        changedAt: null,
        snooze: null,
        activityAt: raw.activityAt,
        ageProvenance: "known" as const,
      };
      const reason =
        operation.reason === "snooze-expired"
          ? ("snooze-expired" as const)
          : ["older", "idle", "target"].includes(operation.reason)
            ? ("idle" as const)
            : ("move" as const);
      const payload = {
        threadId: ThreadId.makeUnsafe(operation.threadId),
        reason,
        source: "automatic" as const,
        organization: {
          ...current,
          state: operation.destination,
          revision: raw.organizationRevision + 1,
          changedAt: occurredAt,
          snooze: null,
        },
        automaticMove: {
          attentionWatermark: live.row.attentionWatermark,
          operationId: operation.operationId,
          ...(operation.batchId ? { batchId: operation.batchId } : {}),
          from: operation.from,
          reason: operation.reason,
        },
      };
      return [
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: payload.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.organization-updated",
          payload: { ...payload, organization: organizationWithAge(current, payload) },
        },
      ] as EventBase[];
    }).pipe(Effect.mapError(toPersistenceSqlError("OrganizationAcceptance")));
});
