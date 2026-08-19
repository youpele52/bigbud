import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Cause, Effect, Option, type Semaphore } from "effect";

import type { OrchestrationProjectionPipelineShape } from "../../orchestration/Services/ProjectionPipeline.ts";
import {
  increment,
  threadRetentionBaselineMaxSequence,
  threadRetentionBaselinePreflightTotal,
  threadRetentionPurgeBacklog,
  withMetrics,
} from "../../observability/Metrics.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type {
  PurgeJob,
  PurgeJobRepositoryShape,
} from "../../persistence/Services/PurgeJobRepository.ts";
import type { EntityPurgeShape } from "../Services/EntityPurge.ts";
import { makeEntityPurgeSql } from "./EntityPurge.sql.ts";

function runCurrentJob(
  input: {
    readonly jobs: PurgeJobRepositoryShape;
    readonly runInternal: (
      job: PurgeJob,
      baselinePreflighted?: boolean,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
  },
  job: PurgeJob,
  baselinePreflighted = false,
) {
  return Effect.gen(function* () {
    const claimedAt = new Date().toISOString();
    const leaseId = crypto.randomUUID();
    const claimed = yield* input.jobs.claimExecution({
      jobId: job.jobId,
      leaseId,
      claimedAt,
      expiresAt: new Date(Date.parse(claimedAt) + 60 * 60 * 1_000).toISOString(),
    });
    if (!claimed) return false;
    return yield* input.jobs
      .findIncomplete({ entityKind: job.entityKind, entityId: job.entityId })
      .pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(false),
            onSome: (current) =>
              current.jobId === job.jobId &&
              !(current.status === "failed" && current.updatedAt > new Date().toISOString())
                ? input.runInternal(current, baselinePreflighted).pipe(Effect.as(true))
                : Effect.succeed(false),
          }),
        ),
        Effect.ensuring(input.jobs.releaseExecution(job.jobId, leaseId).pipe(Effect.ignore)),
      );
  });
}

export function makeEntityPurgeBatch(input: {
  readonly jobs: PurgeJobRepositoryShape;
  readonly projectionPipeline: OrchestrationProjectionPipelineShape;
  readonly queries: ReturnType<typeof makeEntityPurgeSql>;
  readonly runInternal: (
    job: PurgeJob,
    baselinePreflighted?: boolean,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}) {
  const highestBaselineSequence = Effect.fn("EntityPurge.highestBaselineSequence")(function* (
    jobsInBatch: ReadonlyArray<PurgeJob>,
  ) {
    let highest = 0;
    for (const job of jobsInBatch) {
      const entityId =
        job.entityKind === "thread"
          ? ThreadId.makeUnsafe(job.entityId)
          : ProjectId.makeUnsafe(job.entityId);
      const marker = (yield* input.queries.readDeletionMarker({
        entityKind: job.entityKind,
        entityId,
      }))[0];
      if (!marker) continue;
      highest = Math.max(highest, marker.deletionSequence);
      if (job.entityKind !== "project") continue;
      const threads = yield* input.queries.listProjectThreadIds({
        projectId: entityId as ProjectId,
      });
      for (const thread of threads) {
        const threadMarker = (yield* input.queries.readDeletionMarker({
          entityKind: "thread",
          entityId: thread.threadId,
        }))[0];
        highest = Math.max(highest, threadMarker?.deletionSequence ?? 0);
      }
    }
    return highest;
  });

  return Effect.fn("EntityPurge.runBatchInternal")(function* (
    jobsInBatch: ReadonlyArray<PurgeJob>,
  ) {
    const requiredSequence = yield* highestBaselineSequence(jobsInBatch);
    if (requiredSequence > 0) {
      yield* increment(threadRetentionBaselineMaxSequence, {}, requiredSequence);
      yield* input.projectionPipeline
        .ensureVerifiedBaselineThrough(requiredSequence)
        .pipe(withMetrics({ counter: threadRetentionBaselinePreflightTotal }));
    }
    const completed = yield* Effect.forEach(
      jobsInBatch,
      (job) =>
        runCurrentJob(input, job, true).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("entity purge batch job failed", {
                  entityKind: job.entityKind,
                  phase: job.phase,
                }).pipe(Effect.as(false)),
          ),
          Effect.tap(() => Effect.yieldNow),
        ),
      { concurrency: 1 },
    );
    return completed.filter(Boolean).length;
  });
}

export function makeEntityPurgeMaintenance(input: {
  readonly jobs: PurgeJobRepositoryShape;
  readonly maintenanceSemaphore: Semaphore.Semaphore;
  readonly mapError: (operation: string) => (error: unknown) => ProjectionRepositoryError;
  readonly projectionPipeline: OrchestrationProjectionPipelineShape;
  readonly queries: ReturnType<typeof makeEntityPurgeSql>;
  readonly runInternal: (
    job: PurgeJob,
    baselinePreflighted?: boolean,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}) {
  const runBatchInternal = makeEntityPurgeBatch(input);
  const run: EntityPurgeShape["run"] = (job) =>
    input.maintenanceSemaphore.withPermits(1)(runCurrentJob(input, job)).pipe(Effect.asVoid);
  const runBatch: EntityPurgeShape["runBatch"] = (jobsInBatch) =>
    input.maintenanceSemaphore
      .withPermits(1)(
        runBatchInternal(jobsInBatch).pipe(
          Effect.tap((completed) =>
            completed > 0 ? input.projectionPipeline.compactVerifiedPrefix() : Effect.void,
          ),
          Effect.asVoid,
        ),
      )
      .pipe(Effect.mapError(input.mapError("EntityPurge.runBatch")));
  const auditAndResume: EntityPurgeShape["auditAndResume"] = Effect.fn(
    "EntityPurge.auditAndResume",
  )(function* (requestedLimit = 100) {
    return yield* input.maintenanceSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)));
        const batchJobs = new Map<string, PurgeJob>();
        const incompleteJobs = yield* input.jobs.listIncomplete(limit);
        yield* increment(threadRetentionPurgeBacklog, {}, yield* input.jobs.countIncomplete());
        for (const job of incompleteJobs) batchJobs.set(job.jobId, job);
        const completed = yield* runBatchInternal([...batchJobs.values()]);
        if (completed > 0) yield* input.projectionPipeline.compactVerifiedPrefix();
        const orphanBudget = Math.max(0, limit - batchJobs.size);
        if (orphanBudget > 0) yield* input.queries.deleteOrphanRows(orphanBudget);
      }).pipe(Effect.mapError(input.mapError("EntityPurge.auditAndResume"))),
    );
  });
  return { auditAndResume, run, runBatch };
}
