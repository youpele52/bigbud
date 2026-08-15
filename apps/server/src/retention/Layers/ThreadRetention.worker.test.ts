import { assert, it } from "@effect/vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Duration, Effect, Layer, Option, Queue, Ref } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import {
  makeThreadRetentionRunWakeScheduler,
  makeThreadRetentionWakeScheduler,
} from "./ThreadRetention.runtime.ts";
import { forgetFreshManualRun, processThreadRetentionWork } from "./ThreadRetention.worker.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const cutoffAt = "2026-07-01T00:00:00.000Z";
const now = () => Date.parse("2026-08-01T00:01:00.000Z");

layer("thread retention worker priority", (it) => {
  const runWork = Effect.fn("runRetentionWorkerTestWork")(function* (input: {
    readonly work: Parameters<typeof processThreadRetentionWork>[0]["work"];
    readonly readyAt?: number | null;
    readonly purgeBacklog?: number;
  }) {
    const repository = yield* ThreadRetentionRepository;
    const processed = yield* Ref.make<ReadonlyArray<string>>([]);
    const maintenanceReadyAt = yield* Ref.make<number | null>(input.readyAt ?? null);
    const freshManualRunIds = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* processThreadRetentionWork({
      work: input.work,
      maintenanceReadyAt,
      freshManualRunIds,
      repository,
      purgeJobs: { countIncomplete: () => Effect.succeed(input.purgeBacklog ?? 0) },
      purgeBacklogLimit: 100,
      processQueuedRun: (runId) => Ref.update(processed, (runIds) => [...runIds, runId]),
      scheduleFreshManualWake: () => Effect.void,
      cancelWake: () => Effect.void,
      now,
    });
    return { processed: yield* Ref.get(processed), maintenanceReadyAt };
  });

  const clearRuns = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM thread_retention_runs`;
  });

  it.effect("lets a fresh manual wake claim its exact run before startup readiness", () =>
    Effect.gen(function* () {
      yield* clearRuns;
      const repository = yield* ThreadRetentionRepository;
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

      const result = yield* runWork({
        work: { _tag: "freshManual", runId: "fresh-manual" },
      });
      assert.deepEqual(result.processed, ["fresh-manual"]);
      assert.equal(Option.getOrThrow(yield* repository.getRun("older-scheduled")).status, "queued");
    }),
  );

  it.effect("advances active recovery to a checkpoint before the pending manual run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* clearRuns;
        const repository = yield* ThreadRetentionRepository;
        yield* repository.createOrGetActiveRun({
          runId: "recovering-run",
          trigger: "scheduled",
          policy: "7-days",
          cutoffAt,
          createdAt: "2026-08-01T00:00:00.000Z",
        });
        const recoveryThreadId = ThreadId.makeUnsafe("recovery-thread");
        yield* repository.transitionRun({
          runId: "recovering-run",
          expectedStatuses: ["queued"],
          nextStatus: "selecting",
          updatedAt: "2026-08-01T00:00:00.100Z",
        });
        yield* repository.insertSelectedItems({
          runId: "recovering-run",
          candidates: [
            {
              threadId: recoveryThreadId,
              lastActivityAt: cutoffAt,
              deletionCommandId: "recovery-delete",
            },
          ],
          createdAt: "2026-08-01T00:00:00.200Z",
        });
        yield* repository.transitionRun({
          runId: "recovering-run",
          expectedStatuses: ["selecting"],
          nextStatus: "preparing",
          updatedAt: "2026-08-01T00:00:00.300Z",
        });
        yield* repository.transitionItem({
          runId: "recovering-run",
          threadId: recoveryThreadId,
          expectedStatuses: ["selected"],
          nextStatus: "deletion_requested",
          updatedAt: "2026-08-01T00:00:00.400Z",
        });
        yield* repository.createQueuedRun({
          runId: "older-scheduled",
          trigger: "scheduled",
          policy: "14-days",
          cutoffAt,
          createdAt: "2026-08-01T00:00:01.000Z",
        });
        yield* repository.createQueuedRun({
          runId: "fresh-manual",
          trigger: "manual",
          policy: "7-days",
          cutoffAt,
          createdAt: "2026-08-01T00:00:02.000Z",
        });
        const maintenanceReadyAt = yield* Ref.make<number | null>(now() + 10 * 60 * 1_000);
        const freshManualRunIds = yield* Ref.make<ReadonlyArray<string>>([]);
        const processed = yield* Ref.make<ReadonlyArray<string>>([]);
        const workQueue =
          yield* Queue.unbounded<Parameters<typeof processThreadRetentionWork>[0]["work"]>();
        const { scheduleWake, cancelWake } = yield* makeThreadRetentionWakeScheduler({
          workQueue,
          scope: yield* Effect.scope,
          now,
        });
        const processQueuedRun = (runId: string) =>
          Effect.gen(function* () {
            yield* Ref.update(processed, (runIds) => [...runIds, runId]);
            if (runId === "recovering-run") {
              yield* repository.transitionItem({
                runId,
                threadId: recoveryThreadId,
                expectedStatuses: ["deletion_requested"],
                nextStatus: "failed",
                lastErrorCode: "test_failure",
                updatedAt: "2026-08-01T00:01:00.500Z",
              });
              yield* repository.transitionRun({
                runId,
                expectedStatuses: ["preparing"],
                nextStatus: "completed_with_failures",
                updatedAt: "2026-08-01T00:01:00.500Z",
              });
            } else {
              yield* repository.transitionRun({
                runId,
                expectedStatuses: ["queued"],
                nextStatus: "completed",
                updatedAt: "2026-08-01T00:01:00.500Z",
              });
            }
            if (runId === "fresh-manual") {
              yield* forgetFreshManualRun({ runId, freshManualRunIds, cancelWake });
            }
          });
        const process = (work: Parameters<typeof processThreadRetentionWork>[0]["work"]) =>
          processThreadRetentionWork({
            work,
            maintenanceReadyAt,
            freshManualRunIds,
            repository,
            purgeJobs: { countIncomplete: () => Effect.succeed(0) },
            purgeBacklogLimit: 100,
            processQueuedRun,
            scheduleFreshManualWake: (runId, wakeAt) =>
              scheduleWake(runId, wakeAt, { _tag: "freshManual", runId }),
            cancelWake,
            now,
          });

        yield* process({ _tag: "freshManual", runId: "fresh-manual" });
        assert.deepEqual(yield* Ref.get(processed), ["recovering-run", "fresh-manual"]);
        assert.isTrue(Option.isNone(yield* Queue.poll(workQueue)));
        assert.equal(
          Option.getOrThrow(yield* repository.getRun("older-scheduled")).status,
          "queued",
        );
        assert.deepEqual(yield* Ref.get(freshManualRunIds), []);
        assert.isTrue(Option.isNone(yield* Queue.poll(workQueue)));
      }),
    ),
  );

  it.effect("does not preempt a different active manual run", () =>
    Effect.gen(function* () {
      yield* clearRuns;
      const repository = yield* ThreadRetentionRepository;
      yield* repository.createOrGetActiveRun({
        runId: "active-manual",
        trigger: "manual",
        policy: "7-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      yield* repository.createQueuedRun({
        runId: "pending-manual",
        trigger: "manual",
        policy: "7-days",
        cutoffAt,
        createdAt: "2026-08-01T00:00:01.000Z",
      });

      const result = yield* runWork({
        work: { _tag: "freshManual", runId: "pending-manual" },
        readyAt: now() - 1,
      });

      assert.deepEqual(result.processed, ["active-manual"]);
      assert.equal(Option.getOrThrow(yield* repository.getRun("active-manual")).status, "queued");
      assert.equal(Option.getOrThrow(yield* repository.getRun("pending-manual")).status, "queued");
    }),
  );

  it.effect("paces an exact manual retry behind a temporary purge backlog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* clearRuns;
        const repository = yield* ThreadRetentionRepository;
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
        const maintenanceReadyAt = yield* Ref.make<number | null>(now() + 10 * 60 * 1_000);
        const freshManualRunIds = yield* Ref.make<ReadonlyArray<string>>([]);
        const purgeBacklog = yield* Ref.make(100);
        const processed = yield* Ref.make<ReadonlyArray<string>>([]);
        const workQueue =
          yield* Queue.unbounded<Parameters<typeof processThreadRetentionWork>[0]["work"]>();
        const { scheduleWake, cancelWake } = yield* makeThreadRetentionWakeScheduler({
          workQueue,
          scope: yield* Effect.scope,
          now,
        });
        const process = (work: Parameters<typeof processThreadRetentionWork>[0]["work"]) =>
          processThreadRetentionWork({
            work,
            maintenanceReadyAt,
            freshManualRunIds,
            repository,
            purgeJobs: { countIncomplete: () => Ref.get(purgeBacklog) },
            purgeBacklogLimit: 100,
            processQueuedRun: (runId) => Ref.update(processed, (runIds) => [...runIds, runId]),
            scheduleFreshManualWake: (runId, wakeAt) =>
              scheduleWake(runId, wakeAt, { _tag: "freshManual", runId }),
            cancelWake,
            now,
          });

        yield* process({ _tag: "freshManual", runId: "fresh-manual" });
        assert.deepEqual(yield* Ref.get(processed), []);
        assert.isTrue(Option.isNone(yield* Queue.poll(workQueue)));
        yield* Ref.set(purgeBacklog, 0);
        yield* TestClock.adjust("1 second");
        const retry = yield* Queue.take(workQueue);
        yield* process(retry);

        assert.deepEqual(yield* Ref.get(processed), ["fresh-manual"]);
        assert.equal(
          Option.getOrThrow(yield* repository.getRun("older-scheduled")).status,
          "queued",
        );
      }),
    ),
  );

  it.effect("keeps fresh identity through a due nonterminal deferral before readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* clearRuns;
        const repository = yield* ThreadRetentionRepository;
        yield* repository.createQueuedRun({
          runId: "older-scheduled",
          trigger: "scheduled",
          policy: "7-days",
          cutoffAt,
          createdAt: "2026-08-01T00:00:00.000Z",
        });
        yield* repository.createQueuedRun({
          runId: "fresh-deferred",
          trigger: "manual",
          policy: "7-days",
          cutoffAt,
          createdAt: "2026-08-01T00:00:01.000Z",
        });
        const maintenanceReadyAt = yield* Ref.make<number | null>(now() + 10 * 60 * 1_000);
        const freshManualRunIds = yield* Ref.make<ReadonlyArray<string>>([]);
        const processed = yield* Ref.make<ReadonlyArray<string>>([]);
        const workQueue =
          yield* Queue.unbounded<Parameters<typeof processThreadRetentionWork>[0]["work"]>();
        const { scheduleWake, cancelWake } = yield* makeThreadRetentionWakeScheduler({
          workQueue,
          scope: yield* Effect.scope,
          now,
        });
        const scheduleRunWake = makeThreadRetentionRunWakeScheduler({
          freshManualRunIds,
          scheduleWake,
        });
        const retryAt = new Date(now() + 5_000).toISOString();
        const processQueuedRun = (runId: string) =>
          Effect.gen(function* () {
            yield* Ref.update(processed, (runIds) => [...runIds, runId]);
            const run = Option.getOrThrow(yield* repository.getRun(runId));
            if (run.status === "queued") {
              yield* repository.transitionRun({
                runId,
                expectedStatuses: ["queued"],
                nextStatus: "deferred",
                updatedAt: new Date(now()).toISOString(),
                nextAttemptAt: retryAt,
              });
              yield* scheduleRunWake(runId, retryAt);
            } else {
              yield* repository.transitionRun({
                runId,
                expectedStatuses: ["deferred"],
                nextStatus: "completed",
                updatedAt: retryAt,
                nextAttemptAt: null,
              });
              yield* forgetFreshManualRun({ runId, freshManualRunIds, cancelWake });
            }
          });
        const process = (work: Parameters<typeof processThreadRetentionWork>[0]["work"]) =>
          processThreadRetentionWork({
            work,
            maintenanceReadyAt,
            freshManualRunIds,
            repository,
            purgeJobs: { countIncomplete: () => Effect.succeed(0) },
            purgeBacklogLimit: 100,
            processQueuedRun,
            scheduleFreshManualWake: (runId, wakeAt) =>
              scheduleWake(runId, wakeAt, { _tag: "freshManual", runId }),
            cancelWake,
            now,
          });

        yield* process({ _tag: "freshManual", runId: "fresh-deferred" });
        const deferred = Option.getOrThrow(yield* repository.getRun("fresh-deferred"));
        assert.equal(deferred.status, "deferred");
        assert.equal(deferred.nextAttemptAt, retryAt);
        assert.deepEqual(yield* Ref.get(freshManualRunIds), ["fresh-deferred"]);
        yield* TestClock.adjust(Duration.millis(4_999));
        assert.isTrue(Option.isNone(yield* Queue.poll(workQueue)));
        yield* TestClock.adjust(Duration.millis(1));
        const retry = yield* Queue.take(workQueue);
        assert.deepEqual(retry, { _tag: "freshManual", runId: "fresh-deferred" });
        yield* process(retry);

        assert.deepEqual(yield* Ref.get(processed), ["fresh-deferred", "fresh-deferred"]);
        assert.equal(
          Option.getOrThrow(yield* repository.getRun("fresh-deferred")).status,
          "completed",
        );
        assert.equal(
          Option.getOrThrow(yield* repository.getRun("older-scheduled")).status,
          "queued",
        );
        assert.deepEqual(yield* Ref.get(freshManualRunIds), []);
        assert.isTrue(Option.isNone(yield* Queue.poll(workQueue)));
      }),
    ),
  );
});
