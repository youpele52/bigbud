import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import {
  resetRetentionTestRows,
  seedRetentionTestThread,
} from "../../retention/threadRetention.test.helpers.ts";
import {
  clearDeferredDeletionRows,
  countThreadEvents,
  seedDeferredDeletion,
} from "./deferredDeletion.test.helpers.ts";
import { runSoftDeletedThreadPurgeTick } from "./SoftDeletedThreadPurge.ts";

const layer = it.layer(
  ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
const deletedAt = "2026-01-02T00:00:00.000Z";

const remainingThreads = Effect.fn("remainingThreads")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ threadId: string }>`
    SELECT thread_id AS "threadId" FROM projection_threads ORDER BY thread_id
  `;
  return rows.map((row) => row.threadId);
});

const tick = Effect.fn("softDeletedTick")(function* (options: { readonly limit?: number } = {}) {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ProjectionThreadRepository;
  return yield* runSoftDeletedThreadPurgeTick({ sql, threads }, { nowMs, ...options });
});

layer("soft-deleted thread purge", (it) => {
  it.effect("finishes proven soft deletions and leaves everything else", () =>
    Effect.gen(function* () {
      yield* clearDeferredDeletionRows();
      yield* resetRetentionTestRows();
      const sql = yield* SqlClient.SqlClient;
      yield* seedRetentionTestThread("live", deletedAt);
      for (const threadId of ["marked", "history-gone", "unproven", "unprovable"]) {
        yield* seedRetentionTestThread(threadId, deletedAt);
      }
      // Written while the thread was live; triggers block messages on deleted threads.
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('marked-message', 'marked', 'user', 'hello', 0, ${deletedAt}, ${deletedAt})`;
      yield* sql`UPDATE projection_threads SET deleted_at = ${deletedAt} WHERE thread_id <> 'live'`;
      yield* seedDeferredDeletion({ threadId: "marked", deletedAt });
      yield* seedDeferredDeletion({
        threadId: "unprovable",
        deletedAt,
        extraEventAfterBaseline: true,
      });
      // History but no deletion marker: nothing proves the deletion, so it is never selected.
      yield* sql`INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES ('unproven-created', 'thread', 'unproven', 0, 'thread.created', ${deletedAt},
          'unproven-command', NULL, NULL, 'server', '{}', '{}')`;

      const result = yield* tick();

      assert.deepEqual(result, { purged: 2, failed: 1 });
      assert.deepEqual(yield* remainingThreads(), ["live", "unprovable", "unproven"]);
      assert.deepEqual(yield* countThreadEvents("marked"), { events: 0, markers: 0 });
      const messages = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = 'marked'
      `;
      assert.equal(messages[0]?.count, 0);
      assert.deepEqual(yield* countThreadEvents("unprovable"), { events: 3, markers: 1 });

      // The failed one is backed off, so the next tick has nothing to do.
      assert.deepEqual(yield* tick(), { purged: 0, failed: 0 });
    }),
  );

  it.effect("handles at most one batch per tick", () =>
    Effect.gen(function* () {
      yield* clearDeferredDeletionRows();
      yield* resetRetentionTestRows();
      for (let index = 0; index < 30; index += 1) {
        yield* seedRetentionTestThread(`gone-${String(index).padStart(2, "0")}`, deletedAt, {
          deletedAt,
        });
      }
      assert.deepEqual(yield* tick(), { purged: 25, failed: 0 });
      assert.lengthOf(yield* remainingThreads(), 5);
      assert.deepEqual(yield* tick(), { purged: 5, failed: 0 });
      assert.lengthOf(yield* remainingThreads(), 0);
    }),
  );
});
