import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import type { EntityPurgeShape } from "../../deletion/Services/EntityPurge.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";
import type { PurgeJobRepositoryShape } from "../../persistence/Services/PurgeJobRepository.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { makeProcessThreadRetentionRun } from "./ThreadRetention.coordinator.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("thread retention failure isolation", (it) => {
  it.effect("continues successful work and retries one cleanup failure only when due", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const failedThreadId = ThreadId.makeUnsafe("isolated-failure-thread");
      const healthyThreadId = ThreadId.makeUnsafe("isolated-healthy-thread");
      const createdAt = "2026-08-04T00:00:00.000Z";
      let nowMs = Date.parse(createdAt);
      yield* repository.createOrGetActiveRun({
        runId: "isolated-run",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: createdAt,
        createdAt,
      });
      yield* repository.transitionRun({
        runId: "isolated-run",
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: createdAt,
      });
      yield* repository.insertSelectedItems({
        runId: "isolated-run",
        candidates: [
          {
            threadId: failedThreadId,
            lastActivityAt: createdAt,
            deletionCommandId: "isolated-failure-command",
          },
          {
            threadId: healthyThreadId,
            lastActivityAt: createdAt,
            deletionCommandId: "isolated-healthy-command",
          },
        ],
        createdAt,
      });
      yield* repository.transitionRun({
        runId: "isolated-run",
        expectedStatuses: ["selecting"],
        nextStatus: "preparing",
        updatedAt: createdAt,
      });
      for (const threadId of [failedThreadId, healthyThreadId]) {
        yield* repository.transitionItem({
          runId: "isolated-run",
          threadId,
          expectedStatuses: ["selected"],
          nextStatus: "deletion_requested",
          updatedAt: createdAt,
        });
      }

      let failedCleanupCalls = 0;
      let failureRecovered = false;
      const wakes: Array<string> = [];
      const processRun = makeProcessThreadRetentionRun({
        repository,
        purgeJobs: {
          findIncomplete: () => Effect.succeed(Option.none()),
          findById: (jobId: string) =>
            Effect.succeed(Option.some({ jobId, status: "completed" } as never)),
        } as unknown as PurgeJobRepositoryShape,
        receipts: {
          getByCommandId: () => Effect.succeed(Option.none()),
        } as unknown as OrchestrationCommandReceiptRepositoryShape,
        threads: {
          getById: () =>
            Effect.succeed(Option.some({ deletingAt: createdAt, deletedAt: null } as never)),
        } as unknown as ProjectionThreadRepositoryShape,
        entityPurge: {
          requestThread: (threadId: ThreadId) =>
            Effect.succeed({ jobId: `purge-${threadId}` } as never),
          runBatch: () => Effect.void,
        } as unknown as EntityPurgeShape,
        orchestration: {
          dispatch: () => Effect.succeed({ sequence: 1 } as never),
        } as unknown as OrchestrationEngineShape,
        retryRuntimeCleanup: (threadId) =>
          Effect.sync(() => {
            if (threadId !== failedThreadId) return "cleaned" as const;
            failedCleanupCalls += 1;
            return failureRecovered ? ("cleaned" as const) : ("failed" as const);
          }),
        selectionGate: () => Effect.succeed(null),
        scheduleWake: (_runId, wakeAt) =>
          Effect.sync(() => {
            wakes.push(wakeAt);
          }),
        loadRun: (runId) => repository.getRun(runId).pipe(Effect.map(Option.getOrThrow)),
        now: () => nowMs,
      });

      yield* processRun("isolated-run");
      let items = yield* repository.listRunItems("isolated-run");
      assert.equal(items.find((item) => item.threadId === healthyThreadId)?.status, "completed");
      const failedItem = items.find((item) => item.threadId === failedThreadId)!;
      assert.equal(failedItem.status, "deletion_requested");
      assert.isNotNull(failedItem.nextAttemptAt);
      assert.equal(failedCleanupCalls, 1);

      yield* processRun("isolated-run");
      assert.equal(failedCleanupCalls, 1);
      assert.equal((yield* repository.listRecoverableRuns(1)).length, 0);
      assert.equal(wakes.at(-1), failedItem.nextAttemptAt);

      failureRecovered = true;
      nowMs = Date.parse(failedItem.nextAttemptAt!);
      yield* processRun("isolated-run");
      items = yield* repository.listRunItems("isolated-run");
      assert.equal(items.find((item) => item.threadId === failedThreadId)?.status, "completed");
      assert.equal(failedCleanupCalls, 2);
      assert.equal(Option.getOrThrow(yield* repository.getRun("isolated-run")).status, "completed");
    }),
  );
});
