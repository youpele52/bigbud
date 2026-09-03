import { Effect, Layer, Schedule } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts";

import { DirectResourceCleanupExecutor } from "../Services/DirectResourceCleanupExecutor.ts";
import { DirectResourceCleanupRepository } from "../../persistence/Services/DirectResourceCleanupRepository.ts";
import { ServerConfig } from "../../startup/config.ts";
import { resourceRoot } from "./EntityPurge.resources.ts";
import {
  executeDirectCleanupPlan,
  MAX_DIRECT_CLEANUP_EXECUTION_ATTEMPTS,
  withDirectCleanupCapacity,
} from "./DirectResourceCleanupCoordinator.ts";
import { finalizeThreadCanonicalHistoryWithCoverage } from "./CanonicalThreadCleanup.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { recoverPreparedCleanupFinalizes } from "./DirectResourceCleanupRecovery.finalize.ts";
import { recoverDirectCleanupWorktrees } from "./DirectResourceCleanupRecovery.worktrees.ts";

export function recoverCanonicalPruningCandidates<
  Candidate,
  CoverageError,
  FinalizeError,
  Requirements,
>(input: {
  readonly candidates: ReadonlyArray<Candidate>;
  readonly requiredSequence: (candidate: Candidate) => number;
  readonly ensureCoverage: (sequence: number) => Effect.Effect<void, CoverageError, Requirements>;
  readonly finalizeCandidate: (
    candidate: Candidate,
  ) => Effect.Effect<void, FinalizeError, Requirements>;
}): Effect.Effect<void, never, Requirements> {
  if (input.candidates.length === 0) return Effect.void;
  const highestSequence = Math.max(...input.candidates.map(input.requiredSequence));
  return input.ensureCoverage(highestSequence).pipe(
    Effect.andThen(
      Effect.forEach(
        input.candidates,
        (candidate) =>
          input.finalizeCandidate(candidate).pipe(
            Effect.catch((error) =>
              Effect.logWarning("canonical cleanup recovery deferred", {
                detail: String(error),
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.catch((error) =>
      Effect.logWarning("canonical cleanup baseline coverage deferred", {
        detail: String(error),
      }),
    ),
  );
}

export const recoverDirectResourceCleanupOnce = Effect.fn(
  "DirectResourceCleanupRecovery.recoverOnce",
)(function* () {
  const repository = yield* DirectResourceCleanupRepository;
  const executorService = yield* DirectResourceCleanupExecutor;
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const orchestration = yield* OrchestrationEngineService;
  const claimedAt = new Date().toISOString();
  const expectedPlatform = `${process.platform}/${process.arch}`;
  yield* repository.reconcilePrepared(claimedAt, expectedPlatform);
  yield* recoverPreparedCleanupFinalizes({
    repository,
    executorService,
    orchestration,
  });
  const pruning = yield* repository.listCanonicalPruning(10);
  yield* recoverCanonicalPruningCandidates({
    candidates: pruning,
    requiredSequence: (candidate) => candidate.deletionSequence,
    ensureCoverage: (highestSequence) => {
      const verifyReplacement = projectionPipeline.ensureVerifiedBaselineThroughWithoutCompaction;
      return verifyReplacement === undefined
        ? Effect.fail(new Error("verify-only projection baseline support is unavailable"))
        : verifyReplacement(highestSequence);
    },
    finalizeCandidate: (candidate) =>
      finalizeThreadCanonicalHistoryWithCoverage({
        sql,
        threadId: ThreadId.makeUnsafe(candidate.threadId),
        recordCheckpoint: repository.markCanonicalPruned(
          candidate.operationId,
          new Date().toISOString(),
        ),
      }),
  });
  yield* recoverDirectCleanupWorktrees({ repository, config });
  yield* withDirectCleanupCapacity(
    Effect.gen(function* () {
      const leaseId = crypto.randomUUID();
      const plan = yield* repository.claimReady({
        leaseId,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        expectedPlatform,
      });
      if (!plan) return;
      const prepared = yield* Effect.exit(executorService.prepare());
      if (prepared._tag === "Failure") {
        yield* repository
          .scheduleRetry(
            plan.operationId,
            leaseId,
            "process_failure",
            new Date(Date.now() + 5_000).toISOString(),
            true,
          )
          .pipe(
            Effect.andThen(
              plan.attemptCount + 1 >= MAX_DIRECT_CLEANUP_EXECUTION_ATTEMPTS
                ? repository.block(
                    plan.operationId,
                    "retry_budget_exhausted",
                    new Date().toISOString(),
                  )
                : Effect.void,
            ),
            Effect.ensuring(repository.releaseLease(plan.operationId, leaseId).pipe(Effect.ignore)),
          );
        return;
      }
      const executor = prepared.value;
      yield* executeDirectCleanupPlan({
        operationId: plan.operationId,
        leaseId,
        attemptCount: plan.attemptCount,
        planDigest: plan.planDigest,
        proofDigest: plan.proofDigest,
        executor,
        repository,
        resources: plan.resources.map((resource) => ({
          resourceId: resource.resourceId,
          kind: resource.kind,
          root: resourceRoot(config, resource.kind),
          relativePath: resource.relativePath,
          quarantineName: resource.quarantineName,
          ...(resource.entryType && resource.resourceDevice && resource.resourceFileId
            ? {
                identity: {
                  entryType: resource.entryType,
                  deviceOrVolume: resource.resourceDevice,
                  inodeOrFileId: resource.resourceFileId,
                },
              }
            : {}),
          rootIdentity: {
            entryType: "directory",
            deviceOrVolume: resource.rootDevice,
            inodeOrFileId: resource.rootFileId,
          },
          parentIdentity: {
            entryType: "directory",
            deviceOrVolume: resource.parentDevice,
            inodeOrFileId: resource.parentFileId,
          },
          pageOrdinal: resource.pageOrdinal,
        })),
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise(() => executor.shutdown()).pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => executor.close())),
            Effect.andThen(
              repository
                .releaseLease(plan.operationId, leaseId)
                .pipe(Effect.catch(() => Effect.void)),
            ),
          ),
        ),
      );
    }),
  );
});

export const repeatDirectResourceCleanupRecovery = <A, E, R>(recoverOnce: Effect.Effect<A, E, R>) =>
  Effect.repeat(recoverOnce, Schedule.spaced("5 seconds"));

export const DirectResourceCleanupRecoveryLive = Layer.effectDiscard(
  repeatDirectResourceCleanupRecovery(
    recoverDirectResourceCleanupOnce().pipe(
      Effect.catch(() =>
        Effect.logWarning("direct resource cleanup recovery deferred", {
          code: "recovery_failure",
        }),
      ),
    ),
  ).pipe(Effect.forkScoped),
);
