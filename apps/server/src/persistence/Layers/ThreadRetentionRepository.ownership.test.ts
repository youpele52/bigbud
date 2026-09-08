import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("thread retention active-slot ownership", (it) => {
  it.effect("rejects stale run, page, and item writers after ownership is released", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("stale-retention-thread");
      const now = "2026-08-30T00:00:00.000Z";
      yield* repository.createOrGetActiveRun({
        runId: "stale-run",
        trigger: "scheduled",
        policy: "7-days",
        cutoffAt: "2026-08-01T00:00:00.000Z",
        createdAt: now,
      });
      assert.isTrue(
        yield* repository.transitionRun({
          runId: "stale-run",
          expectedStatuses: ["queued"],
          nextStatus: "selecting",
          updatedAt: now,
        }),
      );
      const cursor = { lastActivityAt: "2026-07-01T00:00:00.000Z", threadId };
      assert.isTrue(
        (yield* repository.insertSelectedPage({
          runId: "stale-run",
          expectedStatus: "selecting",
          expectedCursor: null,
          nextCursor: cursor,
          candidates: [
            {
              threadId,
              lastActivityAt: cursor.lastActivityAt,
              deletionCommandId: "retention:stale-run:stale-retention-thread",
            },
          ],
          createdAt: now,
        })).applied,
      );
      assert.isTrue(
        yield* repository.transitionItem({
          runId: "stale-run",
          threadId,
          expectedStatuses: ["selected"],
          nextStatus: "deletion_requested",
          updatedAt: now,
        }),
      );

      yield* sql`UPDATE thread_retention_runs SET active_slot = NULL WHERE run_id = 'stale-run'`;
      assert.equal(
        yield* repository.insertSelectedItems({
          runId: "stale-run",
          candidates: [
            {
              threadId: ThreadId.makeUnsafe("legacy-stale-thread"),
              lastActivityAt: now,
              deletionCommandId: "retention:stale-run:legacy-stale-thread",
            },
          ],
          createdAt: now,
        }),
        0,
      );
      assert.isFalse(
        (yield* repository.insertSelectedPage({
          runId: "stale-run",
          expectedStatus: "selecting",
          expectedCursor: cursor,
          nextCursor: { ...cursor, threadId: ThreadId.makeUnsafe("later-thread") },
          candidates: [],
          createdAt: now,
        })).applied,
      );
      assert.isFalse(
        yield* repository.transitionRun({
          runId: "stale-run",
          expectedStatuses: ["selecting"],
          nextStatus: "preparing",
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* repository.transitionItem({
          runId: "stale-run",
          threadId,
          expectedStatuses: ["deletion_requested"],
          nextStatus: "prepared",
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* repository.recordItemRetry({
          runId: "stale-run",
          threadId,
          expectedStatuses: ["deletion_requested"],
          lastErrorCode: "retry",
          nextAttemptAt: now,
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* repository.recordRequiredBaselineSequence({
          runId: "stale-run",
          sequence: 10,
          updatedAt: now,
        }),
      );
    }),
  );
});
