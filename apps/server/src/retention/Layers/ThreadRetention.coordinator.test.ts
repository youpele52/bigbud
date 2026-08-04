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

const oldAt = "2026-01-01T00:00:00.000Z";
const now = "2026-08-04T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("retention-resume-thread");
const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const unusedReceipts = {
  getByCommandId: () => Effect.succeed(Option.none()),
} as unknown as OrchestrationCommandReceiptRepositoryShape;
const unusedThreads = {
  getById: () => Effect.succeed(Option.none()),
} as unknown as ProjectionThreadRepositoryShape;
const completedPurgeJobs = {
  findIncomplete: () => Effect.succeed(Option.none()),
  findById: (jobId: string) =>
    Effect.succeed(Option.some({ jobId, entityKind: "thread", status: "completed" } as never)),
} as unknown as PurgeJobRepositoryShape;
const unusedPurge = {
  requestThread: () => Effect.die("unused"),
  runBatch: () => Effect.void,
} as unknown as EntityPurgeShape;
const unusedOrchestration = {
  dispatch: () => Effect.die("unused"),
} as unknown as OrchestrationEngineShape;

layer("thread retention coordinator recovery", (it) => {
  it.effect(
    "reconstructs preparation after restart when the deletion reactor event was missed",
    () =>
      Effect.gen(function* () {
        const repository = yield* ThreadRetentionRepository;
        yield* repository.createOrGetActiveRun({
          runId: "missed-reactor-run",
          trigger: "manual",
          policy: "30-days",
          cutoffAt: oldAt,
          createdAt: now,
        });
        yield* repository.transitionRun({
          runId: "missed-reactor-run",
          expectedStatuses: ["queued"],
          nextStatus: "selecting",
          updatedAt: now,
        });
        yield* repository.insertSelectedItems({
          runId: "missed-reactor-run",
          candidates: [{ threadId, lastActivityAt: oldAt, deletionCommandId: "missed-delete" }],
          createdAt: now,
          expectedStatus: "selecting",
          expectedCursor: null,
          nextCursor: { threadId, lastActivityAt: oldAt },
        });
        yield* repository.transitionRun({
          runId: "missed-reactor-run",
          expectedStatuses: ["selecting"],
          nextStatus: "preparing",
          updatedAt: now,
        });
        yield* repository.transitionItem({
          runId: "missed-reactor-run",
          threadId,
          expectedStatuses: ["selected"],
          nextStatus: "deletion_requested",
          updatedAt: now,
        });
        let requestCount = 0;
        let finalizeCount = 0;
        let requiredBaselineSequence: number | null = null;
        const processRun = makeProcessThreadRetentionRun({
          repository: {
            ...repository,
            recordRequiredBaselineSequence: (input: { readonly sequence: number }) =>
              Effect.sync(() => {
                requiredBaselineSequence = input.sequence;
                return true;
              }),
          },
          purgeJobs: completedPurgeJobs,
          receipts: unusedReceipts,
          threads: {
            getById: () =>
              Effect.succeed(Option.some({ deletingAt: now, deletedAt: null } as never)),
          } as unknown as ProjectionThreadRepositoryShape,
          entityPurge: {
            requestThread: () =>
              Effect.sync(() => {
                requestCount += 1;
                return { jobId: "reconstructed-purge-job" } as never;
              }),
            runBatch: () => Effect.void,
          } as unknown as EntityPurgeShape,
          orchestration: {
            dispatch: (command: { readonly type: string }) =>
              Effect.sync(() => {
                if (command.type === "thread.delete.finalize") finalizeCount += 1;
                return { sequence: 1 } as never;
              }),
          } as unknown as OrchestrationEngineShape,
          retryRuntimeCleanup: () => Effect.succeed("cleaned" as const),
          selectionGate: () => Effect.succeed(null),
          scheduleWake: () => Effect.void,
          loadRun: (runId) => repository.getRun(runId).pipe(Effect.map(Option.getOrThrow)),
        });

        yield* processRun("missed-reactor-run");
        assert.equal(requestCount, 1);
        assert.equal(finalizeCount, 1);
        assert.equal(
          (yield* repository.listRunItems("missed-reactor-run"))[0]?.status,
          "completed",
        );
        assert.equal(requiredBaselineSequence, 1);
      }),
  );

  it.effect("resumes a deferred prepared item and releases the active slot", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      yield* repository.createOrGetActiveRun({
        runId: "resume-run",
        trigger: "manual",
        policy: "30-days",
        cutoffAt: oldAt,
        createdAt: now,
      });
      yield* repository.transitionRun({
        runId: "resume-run",
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: now,
      });
      yield* repository.insertSelectedItems({
        runId: "resume-run",
        candidates: [
          {
            threadId,
            lastActivityAt: oldAt,
            deletionCommandId: "resume-delete",
          },
        ],
        createdAt: now,
        expectedStatus: "selecting",
        expectedCursor: null,
        nextCursor: { threadId, lastActivityAt: oldAt },
      });
      yield* repository.transitionRun({
        runId: "resume-run",
        expectedStatuses: ["selecting"],
        nextStatus: "preparing",
        updatedAt: now,
      });
      yield* repository.transitionItem({
        runId: "resume-run",
        threadId,
        expectedStatuses: ["selected"],
        nextStatus: "deletion_requested",
        updatedAt: now,
      });
      yield* repository.markPrepared({
        runId: "resume-run",
        threadId,
        purgeJobId: "completed-purge-job",
        updatedAt: now,
      });
      yield* repository.transitionRun({
        runId: "resume-run",
        expectedStatuses: ["preparing"],
        nextStatus: "deferred",
        updatedAt: now,
        nextAttemptAt: null,
      });

      const loadRun = (runId: string) =>
        repository.getRun(runId).pipe(Effect.map(Option.getOrThrow));
      yield* makeProcessThreadRetentionRun({
        repository,
        purgeJobs: completedPurgeJobs,
        receipts: unusedReceipts,
        threads: unusedThreads,
        entityPurge: unusedPurge,
        orchestration: unusedOrchestration,
        retryRuntimeCleanup: () => Effect.succeed("cleaned" as const),
        selectionGate: () => Effect.succeed(null),
        scheduleWake: () => Effect.void,
        loadRun,
      })("resume-run");

      assert.equal(Option.getOrThrow(yield* repository.getRun("resume-run")).status, "completed");
      assert.equal((yield* repository.listRecoverableRuns(1)).length, 0);
      assert.equal((yield* repository.listRunItems("resume-run"))[0]?.status, "completed");
    }),
  );

  it.effect("completes an all-skipped preparing page with a valid transition", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      yield* repository.createOrGetActiveRun({
        runId: "skipped-run",
        trigger: "manual",
        policy: "30-days",
        cutoffAt: oldAt,
        createdAt: now,
      });
      yield* repository.transitionRun({
        runId: "skipped-run",
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: now,
      });
      yield* repository.insertSelectedItems({
        runId: "skipped-run",
        candidates: [{ threadId, lastActivityAt: oldAt, deletionCommandId: "skipped-delete" }],
        createdAt: now,
        expectedStatus: "selecting",
        expectedCursor: null,
        nextCursor: { threadId, lastActivityAt: oldAt },
      });
      yield* repository.transitionRun({
        runId: "skipped-run",
        expectedStatuses: ["selecting"],
        nextStatus: "preparing",
        updatedAt: now,
      });
      yield* repository.transitionItem({
        runId: "skipped-run",
        threadId,
        expectedStatuses: ["selected"],
        nextStatus: "skipped",
        exclusionReason: "activity_changed",
        updatedAt: now,
      });
      const loadRun = (runId: string) =>
        repository.getRun(runId).pipe(Effect.map(Option.getOrThrow));
      yield* makeProcessThreadRetentionRun({
        repository,
        purgeJobs: completedPurgeJobs,
        receipts: unusedReceipts,
        threads: unusedThreads,
        entityPurge: unusedPurge,
        orchestration: unusedOrchestration,
        retryRuntimeCleanup: () => Effect.succeed("cleaned" as const),
        selectionGate: () => Effect.succeed(null),
        scheduleWake: () => Effect.void,
        loadRun,
      })("skipped-run");

      assert.equal(Option.getOrThrow(yield* repository.getRun("skipped-run")).status, "completed");
    }),
  );

  it.effect("skips an already-active runtime before committing deletion ownership", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      yield* repository.createOrGetActiveRun({
        runId: "active-before-claim-run",
        trigger: "manual",
        policy: "30-days",
        cutoffAt: oldAt,
        createdAt: now,
      });
      yield* repository.transitionRun({
        runId: "active-before-claim-run",
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: now,
      });
      yield* repository.insertSelectedItems({
        runId: "active-before-claim-run",
        candidates: [
          { threadId, lastActivityAt: oldAt, deletionCommandId: "active-before-claim-delete" },
        ],
        createdAt: now,
        expectedStatus: "selecting",
        expectedCursor: null,
        nextCursor: { threadId, lastActivityAt: oldAt },
      });
      yield* repository.transitionRun({
        runId: "active-before-claim-run",
        expectedStatuses: ["selecting"],
        nextStatus: "preparing",
        updatedAt: now,
      });

      yield* makeProcessThreadRetentionRun({
        repository,
        purgeJobs: completedPurgeJobs,
        receipts: unusedReceipts,
        threads: unusedThreads,
        entityPurge: unusedPurge,
        orchestration: unusedOrchestration,
        retryRuntimeCleanup: () => Effect.succeed("active" as const),
        selectionGate: () => Effect.succeed(null),
        scheduleWake: () => Effect.void,
        loadRun: (runId) => repository.getRun(runId).pipe(Effect.map(Option.getOrThrow)),
      })("active-before-claim-run");

      const item = (yield* repository.listRunItems("active-before-claim-run"))[0];
      assert.equal(item?.status, "skipped");
      assert.equal(item?.exclusionReason, "running");
      assert.equal(
        Option.getOrThrow(yield* repository.getRun("active-before-claim-run")).status,
        "completed",
      );
    }),
  );
});
