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

layer("retention cleanup recovery", (it) => {
  it.effect("retries cleanup after restart without aborting or stranding the item", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const threadId = ThreadId.makeUnsafe("cleanup-restart-thread");
      const createdAt = new Date().toISOString();
      yield* repository.createOrGetActiveRun({
        runId: "cleanup-restart-run",
        trigger: "manual",
        policy: "30-days",
        cutoffAt: createdAt,
        createdAt,
      });
      yield* repository.transitionRun({
        runId: "cleanup-restart-run",
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: createdAt,
      });
      yield* repository.insertSelectedItems({
        runId: "cleanup-restart-run",
        candidates: [{ threadId, lastActivityAt: createdAt, deletionCommandId: "cleanup-command" }],
        createdAt,
      });
      yield* repository.transitionRun({
        runId: "cleanup-restart-run",
        expectedStatuses: ["selecting"],
        nextStatus: "preparing",
        updatedAt: createdAt,
      });
      yield* repository.transitionItem({
        runId: "cleanup-restart-run",
        threadId,
        expectedStatuses: ["selected"],
        nextStatus: "deletion_requested",
        updatedAt: createdAt,
      });

      let cleanupReady = false;
      let finalizeCount = 0;
      const purgeJobs = {
        findIncomplete: () => Effect.succeed(Option.none()),
        findById: (jobId: string) =>
          Effect.succeed(Option.some({ jobId, status: "completed" } as never)),
      } as unknown as PurgeJobRepositoryShape;
      const processRun = makeProcessThreadRetentionRun({
        repository,
        purgeJobs,
        receipts: {
          getByCommandId: () => Effect.succeed(Option.none()),
        } as unknown as OrchestrationCommandReceiptRepositoryShape,
        threads: {
          getById: () =>
            Effect.succeed(Option.some({ deletingAt: createdAt, deletedAt: null } as never)),
        } as unknown as ProjectionThreadRepositoryShape,
        entityPurge: {
          requestThread: () => Effect.succeed({ jobId: "cleanup-purge-job" } as never),
          runBatch: () => Effect.void,
        } as unknown as EntityPurgeShape,
        orchestration: {
          dispatch: () =>
            Effect.sync(() => {
              finalizeCount += 1;
              return { sequence: 17 } as never;
            }),
        } as unknown as OrchestrationEngineShape,
        retryRuntimeCleanup: () => Effect.succeed(cleanupReady ? "cleaned" : "failed"),
        selectionGate: () => Effect.succeed(null),
        scheduleWake: () => Effect.void,
        loadRun: (runId) => repository.getRun(runId).pipe(Effect.map(Option.getOrThrow)),
      });

      yield* processRun("cleanup-restart-run");
      const deferredItem = (yield* repository.listRunItems("cleanup-restart-run"))[0]!;
      assert.equal(deferredItem.status, "deletion_requested");
      assert.equal(deferredItem.lastErrorCode, "cleanup_failed");
      assert.equal(finalizeCount, 0);

      cleanupReady = true;
      yield* repository.transitionRun({
        runId: "cleanup-restart-run",
        expectedStatuses: ["deferred"],
        nextStatus: "preparing",
        updatedAt: new Date().toISOString(),
        nextAttemptAt: null,
      });
      yield* processRun("cleanup-restart-run");

      assert.equal(finalizeCount, 1);
      assert.equal((yield* repository.listRunItems("cleanup-restart-run"))[0]?.status, "completed");
      assert.equal(
        Option.getOrThrow(yield* repository.getRun("cleanup-restart-run")).status,
        "completed",
      );
    }),
  );
});
