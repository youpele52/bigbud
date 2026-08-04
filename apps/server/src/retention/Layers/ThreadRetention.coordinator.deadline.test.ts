import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import type { EntityPurgeShape } from "../../deletion/Services/EntityPurge.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";
import type { PurgeJobRepositoryShape } from "../../persistence/Services/PurgeJobRepository.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { RETENTION_SLICE_BUDGET_MS } from "./ThreadRetention.coordinator.helpers.ts";
import { makeProcessThreadRetentionRun } from "./ThreadRetention.coordinator.ts";

const createdAt = "2026-08-04T00:00:00.000Z";
const cutoffAt = "2026-01-01T00:00:00.000Z";
const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("thread retention coordinator deadline", (it) => {
  it.effect("does not dispatch additional selected work after the slice deadline", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const runId = "deadline-run";
      const first = ThreadId.makeUnsafe("deadline-first");
      const second = ThreadId.makeUnsafe("deadline-second");
      yield* repository.createOrGetActiveRun({
        runId,
        trigger: "manual",
        policy: "30-days",
        cutoffAt,
        createdAt,
      });
      yield* repository.transitionRun({
        runId,
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: createdAt,
      });
      yield* repository.insertSelectedItems({
        runId,
        candidates: [
          { threadId: first, lastActivityAt: cutoffAt, deletionCommandId: "deadline-first" },
          { threadId: second, lastActivityAt: cutoffAt, deletionCommandId: "deadline-second" },
        ],
        createdAt,
        expectedStatus: "selecting",
        expectedCursor: null,
        nextCursor: { threadId: second, lastActivityAt: cutoffAt },
      });
      yield* repository.transitionRun({
        runId,
        expectedStatuses: ["selecting"],
        nextStatus: "preparing",
        updatedAt: createdAt,
      });
      let clock = 0;
      let dispatchCount = 0;
      const processRun = makeProcessThreadRetentionRun({
        repository,
        purgeJobs: {} as PurgeJobRepositoryShape,
        receipts: {} as OrchestrationCommandReceiptRepositoryShape,
        threads: {} as ProjectionThreadRepositoryShape,
        entityPurge: {} as EntityPurgeShape,
        orchestration: {
          dispatch: () =>
            Effect.sync(() => {
              dispatchCount += 1;
              clock = RETENTION_SLICE_BUDGET_MS;
              return { sequence: 1 } as never;
            }),
        } as unknown as OrchestrationEngineShape,
        retryRuntimeCleanup: () => Effect.succeed("cleaned" as const),
        selectionGate: () => Effect.succeed(null),
        scheduleWake: () => Effect.void,
        loadRun: (id) => repository.getRun(id).pipe(Effect.map(Option.getOrThrow)),
        now: () => clock,
      });

      yield* processRun(runId);
      assert.equal(dispatchCount, 1);
      assert.equal(Option.getOrThrow(yield* repository.getRun(runId)).status, "deferred");
      yield* repository.transitionRun({
        runId,
        expectedStatuses: ["deferred"],
        nextStatus: "cancelled",
        updatedAt: createdAt,
      });
    }),
  );

  it.effect("times out long preparation work and durably defers the run", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const runId = "preparation-timeout-run";
      const threadId = ThreadId.makeUnsafe("preparation-timeout-thread");
      yield* repository.createOrGetActiveRun({
        runId,
        trigger: "manual",
        policy: "30-days",
        cutoffAt,
        createdAt,
      });
      yield* repository.transitionRun({
        runId,
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: createdAt,
      });
      yield* repository.insertSelectedItems({
        runId,
        candidates: [
          { threadId, lastActivityAt: cutoffAt, deletionCommandId: "preparation-timeout" },
        ],
        createdAt,
        expectedStatus: "selecting",
        expectedCursor: null,
        nextCursor: { threadId, lastActivityAt: cutoffAt },
      });
      yield* repository.transitionRun({
        runId,
        expectedStatuses: ["selecting"],
        nextStatus: "preparing",
        updatedAt: createdAt,
      });
      const processRun = makeProcessThreadRetentionRun({
        repository,
        purgeJobs: {} as PurgeJobRepositoryShape,
        receipts: {} as OrchestrationCommandReceiptRepositoryShape,
        threads: {} as ProjectionThreadRepositoryShape,
        entityPurge: {} as EntityPurgeShape,
        orchestration: {} as OrchestrationEngineShape,
        retryRuntimeCleanup: () => Effect.never,
        selectionGate: () => Effect.succeed(null),
        scheduleWake: () => Effect.void,
        loadRun: (id) => repository.getRun(id).pipe(Effect.map(Option.getOrThrow)),
        now: () => 0,
      });

      const fiber = yield* processRun(runId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(5_000));
      yield* Fiber.join(fiber);
      const run = Option.getOrThrow(yield* repository.getRun(runId));
      assert.equal(run.status, "deferred");
      assert.equal(run.lastErrorCode, "preparation_timeout");
    }),
  );
});
