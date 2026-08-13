import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const cutoffAt = "2026-07-01T00:00:00.000Z";

layer("thread retention run queue", (it) => {
  const claimOrder = Effect.fn("claimRetentionRunOrder")(function* (
    triggers: ReadonlyArray<"manual" | "scheduled">,
  ) {
    const repository = yield* ThreadRetentionRepository;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM thread_retention_run_items`;
    yield* sql`DELETE FROM thread_retention_runs`;
    let scheduledOrdinal = 0;
    const scheduledPolicies = ["7-days", "14-days", "30-days", "90-days"] as const;
    for (const [index, trigger] of triggers.entries()) {
      const policy = trigger === "scheduled" ? scheduledPolicies[scheduledOrdinal++]! : "30-days";
      yield* repository.createQueuedRun({
        runId: `${trigger}-${index}`,
        trigger,
        policy,
        cutoffAt,
        createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
      });
    }
    const order: Array<string> = [];
    while (true) {
      const claimed = yield* repository.claimNextQueuedRun("2026-08-01T01:00:00.000Z");
      if (Option.isNone(claimed)) break;
      order.push(claimed.value.runId);
      yield* repository.transitionRun({
        runId: claimed.value.runId,
        expectedStatuses: ["queued"],
        nextStatus: "completed",
        updatedAt: "2026-08-01T01:00:01.000Z",
      });
    }
    return order;
  });

  it.effect("allows a manual run to overtake only one older scheduled run", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* claimOrder(["scheduled", "scheduled", "manual"]), [
        "scheduled-0",
        "manual-2",
        "scheduled-1",
      ]);
      assert.deepEqual(yield* claimOrder(["scheduled", "manual"]), ["manual-1", "scheduled-0"]);
    }),
  );

  it.effect("preserves FIFO within each trigger", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* claimOrder(["scheduled", "scheduled", "scheduled"]), [
        "scheduled-0",
        "scheduled-1",
        "scheduled-2",
      ]);
      assert.deepEqual(yield* claimOrder(["manual", "manual", "manual"]), [
        "manual-0",
        "manual-1",
        "manual-2",
      ]);
    }),
  );

  it.effect("does not let multiple manuals starve scheduled work", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* claimOrder(["scheduled", "manual", "manual", "manual", "scheduled"]),
        ["manual-1", "scheduled-0", "manual-2", "manual-3", "scheduled-4"],
      );
    }),
  );

  it.effect("deduplicates pending scheduled work and claims only with a free slot", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_runs`;
      const first = yield* repository.createScheduledQueuedRun({
        runId: "scheduled-first",
        trigger: "scheduled",
        policy: "30-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      const duplicate = yield* repository.createScheduledQueuedRun({
        runId: "scheduled-duplicate",
        trigger: "scheduled",
        policy: "30-days",
        cutoffAt,
        createdAt: "2026-08-02T00:00:00.000Z",
      });
      assert.isTrue(first.created);
      assert.isFalse(duplicate.created);
      assert.equal(duplicate.run.runId, "scheduled-first");
      assert.equal(
        Option.getOrThrow(yield* repository.claimNextQueuedRun(cutoffAt)).runId,
        "scheduled-first",
      );
      assert.isTrue(Option.isNone(yield* repository.claimNextQueuedRun(cutoffAt)));
    }),
  );
});
