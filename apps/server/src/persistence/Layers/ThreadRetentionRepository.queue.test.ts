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

  it.effect("claims all queued manual runs before older scheduled runs", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* claimOrder(["scheduled", "scheduled", "manual"]), [
        "manual-2",
        "scheduled-0",
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

  it.effect("drains queued manual work before scheduled work", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* claimOrder(["scheduled", "manual", "manual", "manual", "scheduled"]),
        ["manual-1", "manual-2", "manual-3", "scheduled-0", "scheduled-4"],
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

  it.effect("claims only the requested manual run and respects an occupied active slot", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_runs`;
      yield* repository.createQueuedRun({
        runId: "older-scheduled",
        trigger: "scheduled",
        policy: "7-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      yield* repository.createQueuedRun({
        runId: "fresh-manual",
        trigger: "manual",
        policy: "7-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:01.000Z",
      });

      const claimed = yield* repository.claimQueuedManualRun(
        "fresh-manual",
        "2026-08-01T00:00:02.000Z",
        100,
      );
      assert.equal(Option.getOrThrow(claimed).runId, "fresh-manual");
      assert.isTrue(
        Option.isNone(
          yield* repository.claimQueuedManualRun(
            "older-scheduled",
            "2026-08-01T00:00:03.000Z",
            100,
          ),
        ),
      );
      assert.isTrue(
        Option.isNone(
          yield* repository.claimQueuedManualRun("fresh-manual", "2026-08-01T00:00:03.000Z", 100),
        ),
      );
      assert.equal(
        (yield* repository.getRun("older-scheduled")).pipe(Option.getOrThrow).status,
        "queued",
      );
    }),
  );

  it.effect("enforces the purge backlog gate inside an exact manual claim", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_runs`;
      yield* sql`DELETE FROM purge_jobs`;
      yield* repository.createQueuedRun({
        runId: "backlog-blocked-manual",
        trigger: "manual",
        policy: "7-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          created_at, updated_at
        ) VALUES
          ('backlog-1', 'thread', 'backlog-thread-1', 'awaiting-finalization', 'pending', '[]',
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
          ('backlog-2', 'thread', 'backlog-thread-2', 'awaiting-finalization', 'pending', '[]',
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
      `;

      assert.isTrue(
        Option.isNone(
          yield* repository.claimQueuedManualRun(
            "backlog-blocked-manual",
            "2026-08-01T00:00:01.000Z",
            2,
          ),
        ),
      );
      assert.equal(
        Option.getOrThrow(yield* repository.getRun("backlog-blocked-manual")).status,
        "queued",
      );
      yield* sql`DELETE FROM purge_jobs`;
      assert.equal(
        Option.getOrThrow(
          yield* repository.claimQueuedManualRun(
            "backlog-blocked-manual",
            "2026-08-01T00:00:02.000Z",
            2,
          ),
        ).runId,
        "backlog-blocked-manual",
      );
    }),
  );

  it.effect("persists scheduled runs for both short retention policies", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_runs`;

      for (const [index, policy] of (["7-days", "14-days"] as const).entries()) {
        const result = yield* repository.createScheduledQueuedRun({
          runId: `scheduled-short-${index}`,
          trigger: "scheduled",
          policy,
          cutoffAt,
          createdAt: `2026-08-01T00:00:0${index}.000Z`,
        });
        assert.isTrue(result.created);
        assert.equal(result.run.policy, policy);
      }
    }),
  );

  it.effect("yields a scheduled checkpoint to manual work and resumes it afterward", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_runs`;
      yield* repository.createOrGetActiveRun({
        runId: "active-scheduled",
        trigger: "scheduled",
        policy: "7-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      yield* repository.transitionRun({
        runId: "active-scheduled",
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: "2026-08-01T00:00:01.000Z",
      });
      yield* repository.transitionRun({
        runId: "active-scheduled",
        expectedStatuses: ["selecting"],
        nextStatus: "deferred",
        updatedAt: "2026-08-01T00:00:01.500Z",
        nextAttemptAt: "2026-08-01T00:15:00.000Z",
        lastErrorCode: "page_budget",
      });
      yield* repository.createQueuedRun({
        runId: "priority-manual",
        trigger: "manual",
        policy: "14-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:02.000Z",
      });

      const manual = yield* repository.yieldActiveRunToManual(
        "active-scheduled",
        "priority-manual",
        "2026-08-01T00:00:03.000Z",
        100,
      );
      assert.equal(Option.getOrThrow(manual).runId, "priority-manual");
      assert.equal(
        Option.getOrThrow(yield* repository.getRun("active-scheduled")).status,
        "deferred",
      );
      yield* repository.transitionRun({
        runId: "priority-manual",
        expectedStatuses: ["queued"],
        nextStatus: "completed",
        updatedAt: "2026-08-01T00:00:04.000Z",
      });
      assert.equal(
        Option.getOrThrow(yield* repository.claimNextQueuedRun("2026-08-01T00:00:05.000Z")).runId,
        "active-scheduled",
      );
    }),
  );

  it.effect("lists the active run first and falls back to the highest-priority queue entry", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_runs`;
      yield* repository.createOrGetActiveRun({
        runId: "older-active",
        trigger: "scheduled",
        policy: "7-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      yield* repository.createQueuedRun({
        runId: "newer-manual",
        trigger: "manual",
        policy: "14-days",
        cutoffAt,
        createdAt: "2026-08-02T00:00:00.000Z",
      });
      assert.equal((yield* repository.listRecentRuns(1))[0]?.runId, "older-active");
      yield* repository.transitionRun({
        runId: "older-active",
        expectedStatuses: ["queued"],
        nextStatus: "completed",
        updatedAt: "2026-08-02T00:00:01.000Z",
      });
      assert.equal((yield* repository.listRecentRuns(1))[0]?.runId, "newer-manual");
    }),
  );

  it.effect("preserves a yielded recovery backoff without blocking the manual run", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_runs`;
      yield* repository.createOrGetActiveRun({
        runId: "backing-off-scheduled",
        trigger: "scheduled",
        policy: "7-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      yield* repository.transitionRun({
        runId: "backing-off-scheduled",
        expectedStatuses: ["queued"],
        nextStatus: "deferred",
        updatedAt: "2026-08-01T00:00:01.000Z",
        nextAttemptAt: "2026-08-01T00:30:00.000Z",
        lastErrorCode: "cleanup_failed",
      });
      yield* repository.createQueuedRun({
        runId: "manual-during-backoff",
        trigger: "manual",
        policy: "14-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:02.000Z",
      });
      assert.equal(
        Option.getOrThrow(
          yield* repository.yieldActiveRunToManual(
            "backing-off-scheduled",
            "manual-during-backoff",
            "2026-08-01T00:00:03.000Z",
            100,
          ),
        ).runId,
        "manual-during-backoff",
      );
      yield* repository.transitionRun({
        runId: "manual-during-backoff",
        expectedStatuses: ["queued"],
        nextStatus: "completed",
        updatedAt: "2026-08-01T00:00:04.000Z",
      });
      yield* repository.createQueuedRun({
        runId: "automatic-after-manual",
        trigger: "scheduled",
        policy: "14-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:05.000Z",
      });
      assert.equal(
        Option.getOrThrow(yield* repository.claimNextQueuedRun("2026-08-01T00:30:00.000Z")).runId,
        "backing-off-scheduled",
      );
      yield* repository.transitionRun({
        runId: "backing-off-scheduled",
        expectedStatuses: ["deferred"],
        nextStatus: "completed",
        updatedAt: "2026-08-01T00:30:01.000Z",
      });
      assert.equal(
        Option.getOrThrow(yield* repository.claimNextQueuedRun("2026-08-01T00:30:02.000Z")).runId,
        "automatic-after-manual",
      );
    }),
  );
});
