/**
 * Finishes thread deletions an older build left half done: rows with `deleted_at` set.
 *
 * Before the unified deletion pipeline, `thread.deleted` soft-deleted the projection row and
 * left the rest to `EntityPurge`, which is no longer wired. The current pipeline ignores these
 * rows (`thread.retention-delete` skips them as `already_deleted`, and its delete handler
 * returns early for a thread with `deletedAt`), so they cannot be sent through it again.
 * Instead this applies what the current pipeline does after `thread.deleted`, 25 rows a tick:
 *
 * - a row with a deletion marker: the pipeline's proof-checked canonical cleanup
 *   (`finalizeThreadCanonicalHistoryWithCoverage`), and the projection row is deleted in the
 *   same transaction, exactly as the current `thread.deleted` projector deletes it;
 * - a row with no marker and no canonical events left: only the projection row is deleted;
 * - a row with no marker but canonical events: never selected, since nothing proves the
 *   deletion (none exist on the measured database).
 *
 * A tick stops after 1 second of work; a large history is trimmed in short transactions first
 * and resumes on the next tick. Files are not touched: attachments and worktrees keep their own ownership checks, and
 * unreferenced files are left to the attachment sweep. Failures back off through
 * `deferred_canonical_cleanup_retries`, and a crash mid-tick is safe to resume.
 *
 * @module SoftDeletedThreadPurge
 */
import { ThreadId } from "@bigbud/contracts";
import { Cause, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";
import { trimProvenThreadHistory } from "./CanonicalThreadCleanup.chunked.ts";
import {
  DELETION_CLEANUP_TICK_BUDGET_MS,
  recordDeferredCanonicalCleanupFailure,
} from "./CanonicalThreadCleanup.retry.ts";
import { finalizeThreadCanonicalHistoryWithCoverage } from "./CanonicalThreadCleanup.ts";

export const SOFT_DELETED_PURGE_BATCH = 25;

export interface SoftDeletedThreadPurgeResult {
  readonly purged: number;
  readonly failed: number;
}

interface SoftDeletedRow {
  readonly threadId: string;
  readonly deletionSequence: number | null;
}

export const runSoftDeletedThreadPurgeTick = Effect.fn("runSoftDeletedThreadPurgeTick")(function* (
  input: {
    readonly sql: SqlClient.SqlClient;
    readonly threads: Pick<ProjectionThreadRepositoryShape, "deleteById">;
  },
  options: { readonly nowMs?: number; readonly limit?: number } = {},
) {
  const { sql } = input;
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(SOFT_DELETED_PURGE_BATCH, options.limit ?? 25));
  const rows = yield* sql<SoftDeletedRow>`
    SELECT t.thread_id AS "threadId", marker.deletion_sequence AS "deletionSequence"
    FROM projection_threads AS t
    LEFT JOIN orchestration_deletion_markers AS marker
      ON marker.entity_kind = 'thread' AND marker.entity_id = t.thread_id
    WHERE t.deleted_at IS NOT NULL AND t.deleting_at IS NULL
      AND (marker.deletion_sequence IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM orchestration_events AS event
        WHERE event.aggregate_kind = 'thread' AND event.stream_id = t.thread_id
      ))
      AND NOT EXISTS (
        SELECT 1 FROM deferred_canonical_cleanup_retries AS retry
        WHERE retry.thread_id = t.thread_id AND retry.next_attempt_at > ${new Date(nowMs).toISOString()}
      )
    ORDER BY t.deleted_at ASC, t.thread_id ASC
    LIMIT ${limit}
  `;
  const deadlineMs = Date.now() + DELETION_CLEANUP_TICK_BUDGET_MS;
  let purged = 0;
  let failed = 0;
  for (const row of rows) {
    const threadId = ThreadId.makeUnsafe(row.threadId);
    const deleteProjection = input.threads
      .deleteById({ threadId, threadIds: [threadId] })
      .pipe(
        Effect.andThen(
          sql`DELETE FROM deferred_canonical_cleanup_retries WHERE thread_id = ${row.threadId}`,
        ),
        Effect.asVoid,
      );
    if (Date.now() >= deadlineMs) break;
    const exit = yield* Effect.gen(function* () {
      if (row.deletionSequence === null) {
        yield* sql.withTransaction(deleteProjection);
        return true;
      }
      if (!(yield* trimProvenThreadHistory(sql, threadId, deadlineMs))) return false;
      yield* finalizeThreadCanonicalHistoryWithCoverage({
        sql,
        threadId,
        recordCheckpoint: deleteProjection.pipe(
          Effect.mapError((error) => new Error(String(error))),
        ),
      });
      return true;
    }).pipe(Effect.exit);
    if (exit._tag === "Success") {
      if (!exit.value) break;
      purged += 1;
    } else {
      failed += 1;
      yield* recordDeferredCanonicalCleanupFailure(
        sql,
        {
          threadId: row.threadId,
          deletionSequence: row.deletionSequence ?? 0,
          detail: Cause.pretty(exit.cause),
        },
        nowMs,
      );
    }
    yield* Effect.yieldNow;
  }
  return { purged, failed } satisfies SoftDeletedThreadPurgeResult;
});
