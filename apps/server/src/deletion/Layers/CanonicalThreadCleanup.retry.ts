/**
 * Automatic, bounded retry of thread deletions whose canonical history cleanup was deferred.
 *
 * This reverses the operator-only decision of the 2026-08-18 recovery plan for deletions that
 * no other recovery owns: deletions with a direct-cleanup intent or proof are left to
 * `DirectResourceCleanupRecovery`, and a deletion younger than the grace period is left to the
 * deletion pipeline that is still finishing it.
 *
 * - At most `limit` deletions per tick and at most 1 second of work: a large history is first
 *   trimmed in 500-event transactions (`CanonicalThreadCleanup.chunked`), and a deletion the
 *   budget interrupts resumes on the next tick.
 * - Each deletion uses the pipeline's own proof-checked cleanup
 *   (`finalizeThreadCanonicalHistoryWithCoverage`): only history covered by a verified baseline
 *   is removed, so the retry never needs to build a baseline itself.
 * - A failure backs that deletion off exponentially (1 minute doubling, at most 1 hour) in
 *   `deferred_canonical_cleanup_retries`, and is recorded on the thread's latest retention run
 *   item. Success removes the deletion marker and the retry row in the same transaction.
 *
 * @module CanonicalThreadCleanup.retry
 */
import { ThreadId } from "@bigbud/contracts";
import { Cause, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { trimProvenThreadHistory } from "./CanonicalThreadCleanup.chunked.ts";
import {
  finalizeThreadCanonicalHistoryWithCoverage,
  listDeferredCanonicalThreadCleanupCandidates,
} from "./CanonicalThreadCleanup.ts";

export const DEFERRED_CANONICAL_RETRY_LIMIT = 10;
export const DEFERRED_CANONICAL_RETRY_BASE_MS = 60_000;
export const DEFERRED_CANONICAL_RETRY_MAX_MS = 60 * 60_000;
/** A deletion this recent may still be finishing in the deletion pipeline. */
export const DEFERRED_CANONICAL_RETRY_GRACE_MS = 10 * 60_000;
/** Wall time one tick may spend; shared with the soft-deleted purge. */
export const DELETION_CLEANUP_TICK_BUDGET_MS = 1_000;
const DETAIL_LIMIT = 500;

export function deferredCanonicalRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 16));
  return Math.min(
    DEFERRED_CANONICAL_RETRY_MAX_MS,
    DEFERRED_CANONICAL_RETRY_BASE_MS * 2 ** exponent,
  );
}

export interface DeferredCanonicalRetryResult {
  readonly cleaned: number;
  readonly failed: number;
}

/** Backs one deletion off and records the failure on its latest retention run item. */
export const recordDeferredCanonicalCleanupFailure = Effect.fn(
  "DeferredCanonicalRetry.recordFailure",
)(function* (
  sql: SqlClient.SqlClient,
  input: { readonly threadId: string; readonly deletionSequence: number; readonly detail: string },
  nowMs: number,
) {
  const now = new Date(nowMs).toISOString();
  const previous = yield* sql<{ readonly attemptCount: number; readonly deletionSequence: number }>`
    SELECT attempt_count AS "attemptCount", deletion_sequence AS "deletionSequence"
    FROM deferred_canonical_cleanup_retries WHERE thread_id = ${input.threadId}
  `;
  const prior = previous[0];
  const attemptCount =
    prior !== undefined && prior.deletionSequence === input.deletionSequence
      ? prior.attemptCount + 1
      : 1;
  const nextAttemptAt = new Date(nowMs + deferredCanonicalRetryDelayMs(attemptCount)).toISOString();
  const detail = input.detail.slice(0, DETAIL_LIMIT);
  yield* sql`
    INSERT INTO deferred_canonical_cleanup_retries (
      thread_id, deletion_sequence, attempt_count, next_attempt_at, last_error_code,
      last_error_detail, updated_at
    ) VALUES (${input.threadId}, ${input.deletionSequence}, ${attemptCount}, ${nextAttemptAt},
      'canonical_cleanup_deferred', ${detail}, ${now})
    ON CONFLICT (thread_id) DO UPDATE SET deletion_sequence = excluded.deletion_sequence,
      attempt_count = excluded.attempt_count, next_attempt_at = excluded.next_attempt_at,
      last_error_code = excluded.last_error_code, last_error_detail = excluded.last_error_detail,
      updated_at = excluded.updated_at
  `;
  // The failure is visible on the run that deleted the thread, without changing its outcome.
  yield* sql`
    UPDATE thread_retention_run_items SET last_error_code = 'canonical_cleanup_deferred',
      updated_at = ${now}
    WHERE rowid = (
      SELECT rowid FROM thread_retention_run_items WHERE thread_id = ${input.threadId}
      ORDER BY created_at DESC LIMIT 1
    )
  `;
});

export const runDeferredCanonicalCleanupRetryTick = Effect.fn(
  "runDeferredCanonicalCleanupRetryTick",
)(function* (
  sql: SqlClient.SqlClient,
  options: { readonly nowMs?: number; readonly limit?: number } = {},
) {
  const nowMs = options.nowMs ?? Date.now();
  const startedAt = Date.now();
  const candidates = yield* listDeferredCanonicalThreadCleanupCandidates(
    sql,
    options.limit ?? DEFERRED_CANONICAL_RETRY_LIMIT,
    {
      dueAt: new Date(nowMs).toISOString(),
      deletedBefore: new Date(nowMs - DEFERRED_CANONICAL_RETRY_GRACE_MS).toISOString(),
    },
  );
  const deadlineMs = startedAt + DELETION_CLEANUP_TICK_BUDGET_MS;
  let cleaned = 0;
  let failed = 0;
  for (const candidate of candidates) {
    if (Date.now() >= deadlineMs) break;
    const threadId = ThreadId.makeUnsafe(candidate.threadId);
    const exit = yield* Effect.gen(function* () {
      // Large histories go in short chunks first; an unfinished one resumes next tick.
      if (!(yield* trimProvenThreadHistory(sql, threadId, deadlineMs))) return false;
      yield* finalizeThreadCanonicalHistoryWithCoverage({
        sql,
        threadId,
        recordCheckpoint: sql`
          DELETE FROM deferred_canonical_cleanup_retries WHERE thread_id = ${candidate.threadId}
        `.pipe(Effect.asVoid),
      });
      return true;
    }).pipe(Effect.exit);
    if (exit._tag === "Success") {
      if (!exit.value) break;
      cleaned += 1;
    } else {
      failed += 1;
      yield* recordDeferredCanonicalCleanupFailure(
        sql,
        {
          threadId: candidate.threadId,
          deletionSequence: candidate.deletionSequence,
          detail: Cause.pretty(exit.cause),
        },
        nowMs,
      );
      yield* Effect.logWarning("deferred canonical thread cleanup retry failed", {
        threadId: candidate.threadId,
        deletionSequence: candidate.deletionSequence,
      });
    }
    yield* Effect.yieldNow;
  }
  return { cleaned, failed } satisfies DeferredCanonicalRetryResult;
});
