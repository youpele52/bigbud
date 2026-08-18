import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { safeEntitySegment, threadAttachmentRelativePaths } from "./EntityPurge.assets.ts";
import { makeEntityPurgeCheckpointOps } from "./EntityPurge.checkpoints.ts";
import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import {
  type PurgeJob,
  PurgeJobRepository,
  type PurgeResource,
} from "../../persistence/Services/PurgeJobRepository.ts";
import { ServerConfig } from "../../startup/config.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { EntityPurge, type EntityPurgeShape as PurgeShape } from "../Services/EntityPurge.ts";
import { makeEntityPurgeMaintenance } from "./EntityPurge.batch.ts";
import { EntityPurgeDependenciesLive } from "./EntityPurge.dependencies.ts";
import {
  mapPurgeError,
  persistPurgeFailure,
  purgeResourceOperation,
} from "./EntityPurge.errors.ts";
import {
  exclusiveOwnedLogNames,
  readOwnedLogDirectory,
  verifyOwnedLogsAbsent,
} from "./EntityPurge.logs.ts";
import { makeEntityPurgeSql } from "./EntityPurge.sql.ts";
import { makeEntityPurgeClaims } from "./EntityPurge.claims.ts";
import { makePurgeJobTransitions } from "./EntityPurge.jobs.ts";
import { recordRemovedPurgeResource } from "./EntityPurge.metrics.ts";
import { verifyCanonicalPurgeProof } from "./EntityPurge.proof.ts";
import { assertThreadRuntimeQuiescent } from "./EntityPurge.runtime.ts";
import {
  assertManifestResourceKind,
  captureResourceIdentity,
  deleteResourceAtomically,
  managedRelativePath,
  resolvePurgeResource,
  resourceRoot,
  verifyResourceAbsent,
  verifyResourcePresent,
} from "./EntityPurge.resources.ts";
const makeEntityPurge = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const jobs = yield* PurgeJobRepository;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const checkpointStore = yield* CheckpointStore;
  const queries = makeEntityPurgeSql(sql);
  const maintenanceSemaphore = yield* Semaphore.make(1);
  const captureResource = Effect.fn("EntityPurge.captureResource")(function* (
    kind: PurgeResource["kind"],
    relativePath: string,
  ) {
    const resource = {
      kind,
      relativePath,
      identity: null,
      quarantineName: `.bigbud-purge-${crypto.randomUUID()}`,
      action: "delete",
    } satisfies PurgeResource;
    yield* fs
      .makeDirectory(resourceRoot(config, kind), { recursive: true })
      .pipe(Effect.mapError(mapPurgeError("EntityPurge.captureResourceRoot")));
    const resolved = resolvePurgeResource(config, resource);
    const identity = yield* purgeResourceOperation("EntityPurge.captureResource", () =>
      captureResourceIdentity(resolved),
    );
    return { ...resource, identity } satisfies PurgeResource;
  });
  const { transitionJob } = makePurgeJobTransitions(jobs);
  const {
    assertWorktreeExclusive,
    assertResourceExclusive,
    bindLegacyManifest,
    attachmentIsShared,
    assertResourceClaims,
    acquireResourceClaims,
  } = makeEntityPurgeClaims({
    config,
    queries,
    captureResource,
    resourceOperation: purgeResourceOperation,
    jobs,
    sql,
  });
  const { captureCheckpointRefs, deleteCheckpointRefs } = makeEntityPurgeCheckpointOps({
    checkpointStore,
    queries,
  });
  const requestThread: PurgeShape["requestThread"] = Effect.fn("EntityPurge.requestThread")(
    function* (threadId: ThreadId) {
      return yield* Effect.gen(function* () {
        const jobId = crypto.randomUUID();
        const rows = yield* queries.readThreadAssets({ threadId });
        const resources = new Map<string, PurgeResource>();
        for (const relativePath of threadAttachmentRelativePaths(rows)) {
          resources.set(
            `attachment:${relativePath}`,
            yield* captureResource("attachment", relativePath),
          );
        }
        const worktreePaths = new Set(
          rows.flatMap((row) => (row.worktreePath ? [row.worktreePath] : [])),
        );
        if (worktreePaths.size > 1)
          return yield* Effect.fail(new Error("thread worktree ownership is ambiguous"));
        for (const worktreePath of worktreePaths) {
          const relativePath = managedRelativePath(config.worktreesDir, worktreePath);
          if (!relativePath)
            return yield* Effect.fail(new Error("thread worktree is outside the managed root"));
          const resource = yield* captureResource("managed-worktree", relativePath);
          yield* assertWorktreeExclusive(threadId, resource);
          resources.set(`managed-worktree:${relativePath}`, resource);
        }
        const knownThreadIds = (yield* queries.listKnownThreadIds()).map((row) => row.threadId);
        for (const [kind, directory, type] of [
          ["provider-log", config.providerLogsDir, "provider"],
          ["terminal-history", config.terminalLogsDir, "terminal"],
        ] as const) {
          const entries = yield* purgeResourceOperation("EntityPurge.readOwnedLogDirectory", () =>
            readOwnedLogDirectory(directory),
          );
          for (const relativePath of exclusiveOwnedLogNames({
            entries,
            knownThreadIds,
            threadId,
            type,
          })) {
            resources.set(`${kind}:${relativePath}`, yield* captureResource(kind, relativePath));
          }
        }
        const job = yield* jobs.createOrGet({
          jobId,
          entityKind: "thread",
          entityId: threadId,
          resourceManifest: Array.from(resources.values()),
          createdAt: new Date().toISOString(),
        });
        yield* captureCheckpointRefs(job, rows);
        return yield* acquireResourceClaims(job);
      }).pipe(Effect.mapError(mapPurgeError("EntityPurge.requestThread")));
    },
  );

  const requestProject: PurgeShape["requestProject"] = Effect.fn("EntityPurge.requestProject")(
    function* (projectId) {
      const segment = safeEntitySegment(projectId);
      if (!segment)
        return yield* toPersistenceSqlError("EntityPurge.requestProject")("invalid project id");
      const resourceManifest = yield* Effect.forEach(
        ["project-memory", "project-notes", "project-kanban"] as const,
        (kind) => captureResource(kind, segment),
      );
      return yield* jobs.createOrGet({
        jobId: crypto.randomUUID(),
        entityKind: "project",
        entityId: projectId,
        resourceManifest,
        createdAt: new Date().toISOString(),
      });
    },
  );

  const deleteResources = (job: PurgeJob) =>
    Effect.forEach(
      job.resourceManifest,
      (resource) =>
        Effect.gen(function* () {
          yield* assertResourceExclusive(job, resource);
          const resolved = resolvePurgeResource(config, resource);
          const retainShared =
            job.entityKind === "thread" &&
            resource.kind === "attachment" &&
            resource.action === "retain-shared" &&
            (yield* attachmentIsShared(ThreadId.makeUnsafe(job.entityId), resource));
          if (!retainShared) {
            const removed = yield* purgeResourceOperation("EntityPurge.deleteResources", () =>
              deleteResourceAtomically({ jobId: job.jobId, resolved, resource }),
            );
            yield* recordRemovedPurgeResource(resource.kind, removed);
          }
          yield* Effect.yieldNow;
        }),
      { concurrency: 1, discard: true },
    );

  const verifyResources = (job: PurgeJob) =>
    Effect.forEach(
      job.resourceManifest,
      (resource) => {
        assertManifestResourceKind(job, resource);
        return Effect.gen(function* () {
          const resolved = resolvePurgeResource(config, resource);
          const retainShared =
            job.entityKind === "thread" &&
            resource.kind === "attachment" &&
            resource.action === "retain-shared" &&
            (yield* attachmentIsShared(ThreadId.makeUnsafe(job.entityId), resource));
          yield* purgeResourceOperation("EntityPurge.verifyResources", () =>
            retainShared
              ? verifyResourcePresent({ resolved, resource })
              : verifyResourceAbsent({ jobId: job.jobId, resolved, resource }),
          );
        });
      },
      { concurrency: 1, discard: true },
    );

  const runInternal = Effect.fn("EntityPurge.runInternal")(function* (
    inputJob: PurgeJob,
    baselinePreflighted = false,
  ): Effect.fn.Return<void, ProjectionRepositoryError, never> {
    let failurePhase = inputJob.phase;
    return yield* Effect.gen(function* () {
      const job =
        inputJob.phase === "verifying" || inputJob.phase === "root"
          ? inputJob
          : yield* bindLegacyManifest(inputJob);
      if (
        job.entityKind === "thread" &&
        (job.phase === "awaiting-finalization" || job.phase === "baseline")
      ) {
        yield* captureCheckpointRefs(
          job,
          yield* queries.readThreadAssets({ threadId: ThreadId.makeUnsafe(job.entityId) }),
        );
      }
      const entityId =
        job.entityKind === "thread"
          ? ThreadId.makeUnsafe(job.entityId)
          : ProjectId.makeUnsafe(job.entityId);
      let phase = job.phase;
      let claimedJob = job;
      if (
        phase === "awaiting-finalization" ||
        phase === "baseline" ||
        phase === "database" ||
        phase === "files" ||
        phase === "verifying" ||
        phase === "root"
      ) {
        claimedJob = yield* acquireResourceClaims(job);
      }

      if (phase === "awaiting-finalization") {
        const markers = yield* queries.readDeletionMarker({
          entityKind: job.entityKind,
          entityId,
        });
        if (markers[0] === undefined) {
          return yield* Effect.fail(new Error("entity deletion marker is not yet available"));
        }
        yield* transitionJob(job, "awaiting-finalization", "baseline");
        phase = "baseline";
        failurePhase = phase;
      }
      if (phase === "baseline") {
        const markers = yield* queries.readDeletionMarker({
          entityKind: job.entityKind,
          entityId,
        });
        const marker = markers[0];
        if (marker === undefined) return;
        if (!baselinePreflighted) {
          yield* projectionPipeline.ensureVerifiedBaselineThrough(marker.deletionSequence);
        }
        yield* verifyCanonicalPurgeProof({
          queries,
          entityKind: job.entityKind,
          entityId,
        });
        yield* transitionJob(job, "baseline", "database");
        phase = "database";
        failurePhase = phase;
      }
      if (phase === "database") {
        if (job.entityKind === "thread") {
          const threadId = entityId as ThreadId;
          yield* assertThreadRuntimeQuiescent(queries, threadId);
          yield* queries.deleteThreadDependents({ threadId });
          yield* assertThreadRuntimeQuiescent(queries, threadId);
        } else {
          const projectId = entityId as ProjectId;
          const threads = yield* queries.listProjectThreadIds({ projectId });
          yield* Effect.forEach(
            threads,
            ({ threadId }) =>
              requestThread(threadId).pipe(
                Effect.flatMap((threadJob) => runInternal(threadJob, baselinePreflighted)),
              ),
            { concurrency: 1, discard: true },
          );
          yield* queries.deleteProjectDependents({ projectId });
        }
        yield* transitionJob(job, "database", "files");
        phase = "files";
        failurePhase = phase;
      }
      if (phase === "files") {
        yield* assertResourceClaims(claimedJob);
        if (job.entityKind === "thread")
          yield* assertThreadRuntimeQuiescent(queries, entityId as ThreadId);
        yield* deleteCheckpointRefs(claimedJob);
        if (job.entityKind === "thread")
          yield* assertThreadRuntimeQuiescent(queries, entityId as ThreadId);
        yield* deleteResources(claimedJob);
        yield* transitionJob(job, "files", "verifying");
        phase = "verifying";
        failurePhase = phase;
      }
      if (phase === "verifying") {
        yield* assertResourceClaims(claimedJob);
        const remaining =
          job.entityKind === "thread"
            ? yield* queries.countThreadRows({ threadId: entityId as ThreadId })
            : yield* queries.countProjectRows({ projectId: entityId as ProjectId });
        if (remaining.count > 0) {
          return yield* toPersistenceSqlError("EntityPurge.verifyDatabase")(
            `${remaining.count} owned rows remain`,
          );
        }
        yield* deleteCheckpointRefs(claimedJob);
        yield* verifyResources(claimedJob);
        if (job.entityKind === "thread") {
          const knownThreadIds = (yield* queries.listKnownThreadIds()).map((row) => row.threadId);
          yield* purgeResourceOperation("EntityPurge.verifyOwnedLogs", () =>
            verifyOwnedLogsAbsent({
              providerDirectory: config.providerLogsDir,
              terminalDirectory: config.terminalLogsDir,
              knownThreadIds,
              threadId: job.entityId,
            }),
          );
        }
        yield* transitionJob(job, "verifying", "root");
        phase = "root";
        failurePhase = phase;
      }
      if (phase === "root") {
        yield* assertResourceClaims(claimedJob);
        yield* Effect.uninterruptible(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* verifyCanonicalPurgeProof({
                queries,
                entityKind: job.entityKind,
                entityId,
              });
              if (job.entityKind === "thread")
                yield* assertThreadRuntimeQuiescent(queries, entityId as ThreadId);
              yield* queries.deleteProvenReceipts({ entityKind: job.entityKind, entityId });
              if (job.entityKind === "thread") {
                yield* queries.deleteProvenThreadCanonical({ threadId: entityId as ThreadId });
                yield* queries.deleteThreadRoot({ threadId: entityId as ThreadId });
              } else {
                yield* queries.deleteProjectRoot({ projectId: entityId as ProjectId });
              }
              const completed = yield* jobs.complete({
                jobId: job.jobId,
                completedAt: new Date().toISOString(),
              });
              if (!completed) {
                return yield* Effect.fail(new Error("purge job completion changed remotely"));
              }
            }),
          ),
        );
      }
    }).pipe(
      Effect.catch((error) =>
        persistPurgeFailure({
          attemptCount: inputJob.attemptCount,
          error,
          failurePhase,
          jobId: inputJob.jobId,
          jobs,
        }),
      ),
    );
  });

  const { auditAndResume, run, runBatch } = makeEntityPurgeMaintenance({
    jobs,
    maintenanceSemaphore,
    mapError: mapPurgeError,
    projectionPipeline,
    queries,
    requestProject,
    requestThread,
    runInternal,
  });

  return { requestThread, requestProject, run, runBatch, auditAndResume } satisfies PurgeShape;
});

export const EntityPurgeLive = Layer.effect(EntityPurge, makeEntityPurge).pipe(
  Layer.provide(EntityPurgeDependenciesLive),
);
