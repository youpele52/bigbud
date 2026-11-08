import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { organizationAttentionIds, organizationTimestamp } from "./organizationFacts.build.ts";
import { readOrganizationRawFacts } from "./organizationFacts.query.ts";
import { requestOrganizationRecovery } from "./organizationRecovery.ts";
import { isDeliberateOrganizationChange } from "../orchestration/threadOrganization.aging.ts";

const attentionKinds = new Set([
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
  "delegation.model-choice-requested",
  "delegation.model-choice-resolved",
]);
/** Canonical command transaction hook, NEVER a projection/replay hook. Records deliberate
 * deadlines and request identities before acknowledgment, but makes no scheduling decision.
 */
export const recordOrganizationRuntimeEvent = Effect.fn("OrganizationFacts.recordEvent")(function* (
  sql: SqlClient.SqlClient,
  event: OrchestrationEvent,
  graceMs: number,
) {
  if (event.aggregateKind !== "thread") return;
  if (event.type === "thread.deleted") {
    yield* sql`UPDATE thread_organization_runtime SET singleton = singleton WHERE singleton = 1`;
    for (const id of new Set([event.payload.threadId, ...(event.payload.threadIds ?? [])])) {
      yield* sql`INSERT INTO thread_organization_runtime_threads (thread_id, fact_version, source_frontier,
        transition_digest, attention_watermark, deleted) VALUES (${id}, 1, ${event.sequence}, 'canonical-deletion', 0, 1)
        ON CONFLICT (thread_id) DO UPDATE SET fact_version = fact_version + 1, source_frontier = ${event.sequence},
          deleted = 1, semantic_digest = '', transition_digest = 'canonical-deletion'`;
    }
    yield* sql`UPDATE thread_organization_runtime SET canonical_frontier = MAX(canonical_frontier, ${event.sequence}) WHERE singleton = 1`;
    return;
  }
  const human =
    (event.type === "thread.message-sent" &&
      event.payload.role === "user" &&
      !event.payload.streaming &&
      event.payload.replace !== true &&
      (event.payload.originSegments ?? []).every((segment) => segment.actor === "user")) ||
    (event.type === "thread.prompt-queued" &&
      event.payload.prompt.alreadySent !== true &&
      (event.payload.prompt.originSegments ?? []).every((segment) => segment.actor === "user"));
  const response =
    event.type === "thread.approval-response-requested" ||
    event.type === "thread.user-input-response-requested";
  const attention =
    event.type === "thread.activity-appended" && attentionKinds.has(event.payload.activity.kind);
  if (event.type !== "thread.organization-updated" && !human && !response && !attention) return;
  yield* sql`UPDATE thread_organization_runtime SET singleton = singleton WHERE singleton = 1`;
  const [raw] = yield* readOrganizationRawFacts(sql, event.aggregateId);
  if (!raw || raw.deleted === 1) return;
  const at = organizationTimestamp(event.occurredAt);
  const updated = event.type === "thread.organization-updated" ? event.payload : null;
  const deliberate = updated !== null && isDeliberateOrganizationChange(updated);
  const reminder =
    updated?.reason === "snooze-expired"
      ? 1
      : deliberate || human || response
        ? 0
        : (raw.needsAttentionReminder ?? 0);
  const ids = organizationAttentionIds(raw.attentionIdsJson);
  if (reminder) ids.push("snooze-reminder");
  const previous = new Set(organizationAttentionIds(raw.attentionHistoryJson ?? "[]"));
  const watermark = (raw.attentionWatermark ?? 0) + (ids.some((id) => !previous.has(id)) ? 1 : 0);
  const manual =
    updated === null
      ? raw.manualUntilMs
      : deliberate && ["move", "unarchive"].includes(updated.reason)
        ? at + 600000
        : null;
  const manualWatermark = updated !== null ? watermark : (raw.manualAttentionWatermark ?? 0);
  // Deliberate returns and automatic resolved returns to Present both get the shared grace.
  const graced = deliberate || updated?.automaticMove?.reason === "resolved";
  const grace =
    graced && updated?.organization.state === "present"
      ? Math.max(raw.graceUntilMs ?? 0, at + graceMs)
      : raw.graceUntilMs;
  // Automatic placement identity (Undo + resolved return) changes only on organisation updates;
  // a human message is new work and clears it. Request/response activity keeps it, so an
  // answered automatic Needs you placement can still return to Present.
  const placementChanges = updated !== null || human;
  const version = (raw.factVersion ?? 0) + 1;
  if (![watermark, version, manual ?? 0, grace ?? 0].every(Number.isSafeInteger))
    return yield* Effect.fail(new Error("organisation runtime counter overflow"));
  yield* sql`INSERT INTO thread_organization_runtime_threads (thread_id, fact_version, source_frontier,
    transition_digest, deliberate_organization_at_ms, manual_until_ms, attention_watermark, grace_until_ms,
    deleted, manual_attention_watermark, attention_ids_json, needs_attention_reminder)
    VALUES (${raw.threadId}, ${version}, ${event.sequence}, 'canonical-organization',
      ${deliberate ? at : null}, ${manual}, ${watermark}, ${grace}, 0, ${manualWatermark}, ${JSON.stringify(ids)}, ${reminder})
    ON CONFLICT (thread_id) DO UPDATE SET fact_version = excluded.fact_version, source_frontier = excluded.source_frontier,
      transition_digest = excluded.transition_digest, semantic_digest = '',
      deliberate_organization_at_ms = CASE WHEN ${deliberate ? 1 : 0} THEN MAX(COALESCE(deliberate_organization_at_ms, 0), ${at}) ELSE deliberate_organization_at_ms END,
      manual_until_ms = excluded.manual_until_ms, attention_watermark = excluded.attention_watermark,
      grace_until_ms = excluded.grace_until_ms, manual_attention_watermark = excluded.manual_attention_watermark,
      attention_ids_json = excluded.attention_ids_json, needs_attention_reminder = excluded.needs_attention_reminder,
      latest_automatic_move_id = CASE WHEN ${placementChanges ? 1 : 0}
        THEN ${updated?.automaticMove?.operationId ?? null} ELSE latest_automatic_move_id END`;
  yield* sql`UPDATE thread_organization_runtime SET canonical_frontier = MAX(canonical_frontier, ${event.sequence}) WHERE singleton = 1`;
  // A successful manual move is an explicit recovery signal for a paused organiser.
  if (deliberate) requestOrganizationRecovery(sql);
});
