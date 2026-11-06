import type { OrchestrationCommand, OrchestrationEvent } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadOrganizationOperations } from "../persistence/Layers/ThreadOrganizationOperations.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { makeOrganizationOwnerFacts } from "./organizationFacts.owners.ts";
import { readOrganizationRawFacts } from "./organizationFacts.query.ts";
import { buildOrganizationFacts } from "./organizationFacts.build.ts";
import { organizationWithAge } from "../orchestration/threadOrganization.aging.ts";
import { withEventBase } from "../orchestration/deciderHelpers.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

type Undo = Extract<OrchestrationCommand, { type: "thread.organization.move" }>;
/** Inside canonical command transaction. The command receipt deduplicates even an obsolete Undo.
 * A changed revision/current move/request or unsafe current destination is a truthful no-op.
 */
export const makeOrganizationUndo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const operations = yield* makeThreadOrganizationOperations;
  const settings = yield* ServerSettingsService;
  const owners = yield* makeOrganizationOwnerFacts;
  return (command: Undo) =>
    Effect.gen(function* () {
      const events: Omit<OrchestrationEvent, "sequence">[] = [];
      yield* sql`UPDATE thread_organization_runtime SET singleton = singleton WHERE singleton = 1`;
      const prepared = command.undoAutomaticMoveId
        ? yield* operations.read(command.undoAutomaticMoveId)
        : undefined;
      if (
        !prepared ||
        prepared.outcome?.status !== "applied" ||
        prepared.operation.threadId !== command.threadId ||
        prepared.operation.from !== command.state ||
        prepared.outcome.resultRevision !== command.expectedRevision
      )
        return events;
      const [raw] = yield* readOrganizationRawFacts(sql, command.threadId);
      const [runtime] = yield* sql<{
        latest_automatic_move_id: string | null;
        attention_watermark: number;
      }>`SELECT latest_automatic_move_id, attention_watermark FROM thread_organization_runtime_threads WHERE thread_id = ${command.threadId}`;
      if (
        !raw ||
        !runtime ||
        runtime.latest_automatic_move_id !== command.undoAutomaticMoveId ||
        raw.organizationRevision !== command.expectedRevision ||
        !raw.inScope
      )
        return events;
      const now = Date.now();
      const grace = (yield* settings.getSettings).inyosiraGraceMinutes * 60000;
      const facts = buildOrganizationFacts(raw, yield* owners(command.threadId), now, grace).row;
      // Needs you remains authoritative; unknown/running work must not be hidden by Undo.
      if (
        (facts.actionable && command.state !== "needs-you") ||
        (facts.work !== 1 && command.state !== "present" && command.state !== "needs-you")
      )
        return events;
      const [moveFacts] = yield* sql<{
        attention_watermark: number;
      }>`SELECT attention_watermark FROM thread_organization_runtime_threads WHERE thread_id = ${command.threadId}`;
      // A genuine new request since the automatic move invalidates restoration even if answered.
      const [moveEvent] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_events WHERE command_id = ${prepared.operation.operationId} AND event_type = 'thread.organization-updated' LIMIT 1`;
      if (!moveEvent) return events;
      const payload: unknown = JSON.parse(moveEvent.payload_json);
      if (!payload || typeof payload !== "object" || !("automaticMove" in payload)) return events;
      const automatic = payload.automaticMove;
      if (
        !automatic ||
        typeof automatic !== "object" ||
        !("attentionWatermark" in automatic) ||
        automatic.attentionWatermark !== moveFacts?.attention_watermark
      )
        return events;
      const occurredAt = new Date(now).toISOString();
      const current = {
        state: prepared.operation.destination,
        revision: raw.organizationRevision,
        changedAt: null,
        snooze: null,
        activityAt: raw.activityAt,
        ageProvenance: "known" as const,
      };
      const change = {
        threadId: command.threadId,
        reason: "move" as const,
        source: "deliberate" as const,
        organization: {
          ...current,
          state: command.state,
          revision: raw.organizationRevision + 1,
          changedAt: occurredAt,
          snooze: null,
        },
      };
      yield* sql`UPDATE thread_organization_runtime_threads SET grace_until_ms = MAX(COALESCE(grace_until_ms, 0), ${now + grace}) WHERE thread_id = ${command.threadId}`;
      yield* sql`UPDATE thread_organization_runtime SET target_drain_not_before_ms = MAX(COALESCE(target_drain_not_before_ms, 0), ${now + grace}) WHERE singleton = 1`;
      events.push({
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          commandId: command.commandId,
          occurredAt,
        }),
        type: "thread.organization-updated",
        payload: { ...change, organization: organizationWithAge(current, change) },
      });
      return events;
    }).pipe(Effect.mapError(toPersistenceSqlError("OrganizationUndo")));
});
