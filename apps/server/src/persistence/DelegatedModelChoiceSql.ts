import {
  DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND,
  DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The one definition of "unresolved delegated model-choice request": two materialized CTEs for a
 * `WITH` clause, exposing `model_choice_unresolved(activity_id, thread_id, payload_json,
 * created_at)`. Both sides are read once through the `(kind, created_at)` index and anti-joined
 * through an automatic index on `(thread_id, choice_id)`. The cost is O(requests + resolutions)
 * and never a correlated subquery per activity row (startup window, sweep, per-thread window).
 *
 * Pass `threadId` on per-thread paths (lazy thread loads): both CTEs are then scoped to that
 * thread, because a filter outside a `MATERIALIZED` CTE cannot reach inside it and would
 * otherwise scan every model-choice activity in the database on each load.
 */
export function unresolvedModelChoiceRequestsCtes(sql: SqlClient.SqlClient, threadId?: string) {
  const scopeResolved = threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`;
  const scopeRequested =
    threadId === undefined ? sql`` : sql`AND requested.thread_id = ${threadId}`;
  return sql`
    model_choice_resolved AS MATERIALIZED (
      SELECT thread_id, json_extract(payload_json, '$.choiceId') AS choice_id
      FROM projection_thread_activities
      WHERE kind = ${DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND}
        ${scopeResolved}
    ),
    model_choice_unresolved AS MATERIALIZED (
      SELECT
        requested.activity_id, requested.thread_id, requested.payload_json, requested.created_at
      FROM projection_thread_activities requested
      LEFT JOIN model_choice_resolved resolved
        ON resolved.thread_id = requested.thread_id
        AND resolved.choice_id = json_extract(requested.payload_json, '$.choiceId')
      WHERE requested.kind = ${DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND}
        ${scopeRequested}
        AND resolved.thread_id IS NULL
    )
  `;
}
