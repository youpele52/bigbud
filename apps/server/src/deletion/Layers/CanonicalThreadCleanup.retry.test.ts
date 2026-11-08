import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  DEFERRED_CANONICAL_RETRY_BASE_MS,
  DEFERRED_CANONICAL_RETRY_GRACE_MS,
  DEFERRED_CANONICAL_RETRY_MAX_MS,
  deferredCanonicalRetryDelayMs,
  runDeferredCanonicalCleanupRetryTick,
} from "./CanonicalThreadCleanup.retry.ts";
import {
  clearDeferredDeletionRows,
  countThreadEvents,
  seedDeferredDeletion,
} from "./deferredDeletion.test.helpers.ts";

const layer = it.layer(SqlitePersistenceMemory);
const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
const oldAt = new Date(nowMs - 24 * 60 * 60_000).toISOString();

const readRetry = Effect.fn("readDeferredRetry")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ attemptCount: number; nextAttemptAt: string; code: string }>`
    SELECT attempt_count AS "attemptCount", next_attempt_at AS "nextAttemptAt",
      last_error_code AS code
    FROM deferred_canonical_cleanup_retries WHERE thread_id = ${threadId}
  `;
  return rows[0];
});

layer("deferred canonical cleanup retry", (it) => {
  it.effect("cleans covered deletions and leaves recent or direct-cleanup ones alone", () =>
    Effect.gen(function* () {
      yield* clearDeferredDeletionRows();
      const sql = yield* SqlClient.SqlClient;
      yield* seedDeferredDeletion({ threadId: "old", deletedAt: oldAt });
      yield* seedDeferredDeletion({
        threadId: "recent",
        deletedAt: new Date(nowMs - DEFERRED_CANONICAL_RETRY_GRACE_MS + 1_000).toISOString(),
      });
      yield* seedDeferredDeletion({ threadId: "owned", deletedAt: oldAt });
      yield* sql`
        INSERT INTO direct_resource_cleanup_intents (
          intent_id, event_id, source_command_id, source_payload_digest_version,
          source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
        ) VALUES ('intent-owned', 'intent-event-owned', 'source-owned', 'v1', 'source', 'thread',
          'owned', 'single', ${oldAt})
      `;

      const result = yield* runDeferredCanonicalCleanupRetryTick(sql, { nowMs });

      assert.deepEqual(result, { cleaned: 1, failed: 0 });
      assert.deepEqual(yield* countThreadEvents("old"), { events: 0, markers: 0 });
      assert.deepEqual(yield* countThreadEvents("recent"), { events: 2, markers: 1 });
      assert.deepEqual(yield* countThreadEvents("owned"), { events: 2, markers: 1 });
    }),
  );

  it.effect("backs a failing deletion off and records it on the retention run item", () =>
    Effect.gen(function* () {
      yield* clearDeferredDeletionRows();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_runs`;
      yield* sql`INSERT INTO thread_retention_runs (
          run_id, trigger_kind, policy, selection_mode, age_criterion, cutoff_at, status,
          active_slot, eligible_count, created_at, updated_at
        ) VALUES ('run-1', 'scheduled', '3-days', 'per-thread', 'last-conversation-activity',
          ${oldAt}, 'completed', NULL, 1, ${oldAt}, ${oldAt})`;
      yield* sql`INSERT INTO thread_retention_run_items (
          run_id, thread_id, expected_last_activity_at, deletion_command_id, status,
          created_at, updated_at
        ) VALUES ('run-1', 'failing', ${oldAt}, 'retention-delete-failing', 'completed',
          ${oldAt}, ${oldAt})`;
      yield* seedDeferredDeletion({
        threadId: "failing",
        deletedAt: oldAt,
        extraEventAfterBaseline: true,
      });

      const first = yield* runDeferredCanonicalCleanupRetryTick(sql, { nowMs });
      assert.deepEqual(first, { cleaned: 0, failed: 1 });
      assert.deepEqual(yield* readRetry("failing"), {
        attemptCount: 1,
        nextAttemptAt: new Date(nowMs + DEFERRED_CANONICAL_RETRY_BASE_MS).toISOString(),
        code: "canonical_cleanup_deferred",
      });
      const item = yield* sql<{ code: string; status: string }>`
        SELECT last_error_code AS code, status FROM thread_retention_run_items
        WHERE thread_id = 'failing'
      `;
      assert.deepEqual(item[0], { code: "canonical_cleanup_deferred", status: "completed" });

      // In backoff: not attempted again before it is due.
      const early = yield* runDeferredCanonicalCleanupRetryTick(sql, { nowMs: nowMs + 30_000 });
      assert.deepEqual(early, { cleaned: 0, failed: 0 });

      const due = nowMs + DEFERRED_CANONICAL_RETRY_BASE_MS;
      assert.deepEqual(yield* runDeferredCanonicalCleanupRetryTick(sql, { nowMs: due }), {
        cleaned: 0,
        failed: 1,
      });
      assert.equal((yield* readRetry("failing"))?.attemptCount, 2);
      assert.deepEqual(yield* countThreadEvents("failing"), { events: 3, markers: 1 });
    }),
  );

  it.effect("doubles the delay up to one hour", () =>
    Effect.sync(() => {
      assert.equal(deferredCanonicalRetryDelayMs(1), DEFERRED_CANONICAL_RETRY_BASE_MS);
      assert.equal(deferredCanonicalRetryDelayMs(2), 2 * DEFERRED_CANONICAL_RETRY_BASE_MS);
      assert.equal(deferredCanonicalRetryDelayMs(7), DEFERRED_CANONICAL_RETRY_MAX_MS);
      assert.equal(deferredCanonicalRetryDelayMs(50), DEFERRED_CANONICAL_RETRY_MAX_MS);
    }),
  );
});
