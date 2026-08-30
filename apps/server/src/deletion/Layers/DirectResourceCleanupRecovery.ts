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
import { finalizeThreadCanonicalHistory } from "./CanonicalThreadCleanup.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";

const recoverOnce = Effect.fn("DirectResourceCleanupRecovery.recoverOnce")(function* () {
  const repository = yield* DirectResourceCleanupRepository;
  const executorService = yield* DirectResourceCleanupExecutor;
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const claimedAt = new Date().toISOString();
  const expectedPlatform = `${process.platform}/${process.arch}`;
  yield* repository.reconcilePrepared(claimedAt, expectedPlatform);
  const pruning = yield* repository.listCanonicalPruning(10);
  yield* Effect.forEach(
    pruning,
    (candidate) =>
      finalizeThreadCanonicalHistory({
        projectionPipeline,
        sql,
        threadId: ThreadId.makeUnsafe(candidate.threadId),
        deletionSequence: candidate.deletionSequence,
      }).pipe(
        Effect.andThen(
          repository.markCanonicalPruned(candidate.operationId, new Date().toISOString()),
        ),
      ),
    { concurrency: 1, discard: true },
  );
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

export const DirectResourceCleanupRecoveryLive = Layer.effectDiscard(
  Effect.repeat(
    recoverOnce().pipe(
      Effect.catch(() =>
        Effect.logWarning("direct resource cleanup recovery deferred", {
          code: "recovery_failure",
        }),
      ),
    ),
    Schedule.fixed("5 seconds"),
  ).pipe(Effect.forkScoped),
);
