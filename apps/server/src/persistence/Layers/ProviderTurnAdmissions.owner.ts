import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissionConflict } from "../Services/ProviderTurnAdmissions.ts";
import { toPersistenceSqlError } from "../Errors.ts";

/** Canonical deletion fences survive history compaction; no native history or replay marker expires. */
export function admissionOwnerAvailable(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql`NOT EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = ${threadId} AND (deleted_at IS NOT NULL OR deleting_at IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM orchestration_deletion_markers WHERE entity_kind = 'thread' AND entity_id = ${threadId})
    AND NOT EXISTS (SELECT 1 FROM purge_jobs WHERE entity_kind = 'thread' AND entity_id = ${threadId} AND manifest_sealed_at IS NOT NULL)
    AND NOT EXISTS (
      WITH RECURSIVE ancestors(thread_id) AS (
        SELECT ${threadId}
        UNION SELECT thread.parent_thread_id FROM projection_threads AS thread
          JOIN ancestors ON thread.thread_id = ancestors.thread_id WHERE thread.parent_thread_id IS NOT NULL
      ) SELECT 1 FROM thread_retention_run_items AS item
        JOIN thread_retention_runs AS run ON run.run_id = item.run_id
        WHERE item.status = 'deletion_requested' AND (item.thread_id = ${threadId}
          OR (run.selection_mode = 'legacy-subtree' AND item.thread_id IN (SELECT thread_id FROM ancestors)))
    )
    AND NOT EXISTS (SELECT 1 FROM purge_resource_claims WHERE entity_kind = 'thread' AND entity_id = ${threadId})`;
}

export function assertAdmissionOwnerAvailable(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return Effect.gen(function* () {
    const unavailable =
      yield* sql`SELECT 1 WHERE NOT (${admissionOwnerAvailable(sql, threadId)})`.pipe(
        Effect.mapError(toPersistenceSqlError("admissions.owner")),
      );
    if (unavailable.length)
      return yield* new ProviderTurnAdmissionConflict({
        detail:
          "Admission owner is deleting/deleted; retained history cannot license new execution.",
      });
  });
}
