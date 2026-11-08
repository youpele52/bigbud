import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { CANONICAL_TRIM_CHUNK, trimProvenThreadHistory } from "./CanonicalThreadCleanup.chunked.ts";
import { runDeferredCanonicalCleanupRetryTick } from "./CanonicalThreadCleanup.retry.ts";
import {
  clearDeferredDeletionRows,
  countThreadEvents,
  seedDeferredDeletion,
} from "./deferredDeletion.test.helpers.ts";

const layer = it.layer(SqlitePersistenceMemory);
const deletedAt = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("large-history");

const gapCount = Effect.fn("gapCount")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM orchestration_event_gaps`;
  return rows[0]?.count ?? 0;
});

layer("chunked canonical history trim", (it) => {
  it.effect("removes a large history in chunks and keeps the deletion event", () =>
    Effect.gen(function* () {
      yield* clearDeferredDeletionRows();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_event_gaps`;
      const deletionSequence = yield* seedDeferredDeletion({
        threadId,
        deletedAt,
        historyEvents: 2 * CANONICAL_TRIM_CHUNK + 20,
      });

      // A spent budget does nothing and asks to be resumed.
      assert.isFalse(yield* trimProvenThreadHistory(sql, threadId, Date.now() - 1));
      assert.equal((yield* countThreadEvents(threadId)).events, 2 * CANONICAL_TRIM_CHUNK + 21);

      assert.isTrue(yield* trimProvenThreadHistory(sql, threadId, Date.now() + 60_000));
      // Two full chunks went; the remainder and the deletion event wait for the finalize.
      assert.deepEqual(yield* countThreadEvents(threadId), { events: 21, markers: 1 });
      assert.equal(yield* gapCount(), 2 * CANONICAL_TRIM_CHUNK);
      const deletion = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events WHERE sequence = ${deletionSequence}
      `;
      assert.equal(deletion[0]?.count, 1);

      const tick = yield* runDeferredCanonicalCleanupRetryTick(sql, {
        nowMs: Date.parse("2026-03-01T00:00:00.000Z"),
      });
      assert.deepEqual(tick, { cleaned: 1, failed: 0 });
      assert.deepEqual(yield* countThreadEvents(threadId), { events: 0, markers: 0 });
      assert.equal(yield* gapCount(), 2 * CANONICAL_TRIM_CHUNK + 21);
    }),
  );

  it.effect("refuses to trim history the baseline does not cover", () =>
    Effect.gen(function* () {
      yield* clearDeferredDeletionRows();
      const sql = yield* SqlClient.SqlClient;
      yield* seedDeferredDeletion({
        threadId,
        deletedAt,
        historyEvents: CANONICAL_TRIM_CHUNK + 5,
        extraEventAfterBaseline: true,
      });
      const exit = yield* trimProvenThreadHistory(sql, threadId, Date.now() + 60_000).pipe(
        Effect.exit,
      );
      assert.equal(exit._tag, "Failure");
      assert.equal((yield* countThreadEvents(threadId)).events, CANONICAL_TRIM_CHUNK + 7);
    }),
  );
});
