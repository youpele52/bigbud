import path from "node:path";

import { ChatAttachment, ProjectId, ThreadId } from "@bigbud/contracts";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";
import { Effect, FileSystem, Layer, Result, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { attachmentRelativePath } from "../../attachments/attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../../attachments/attachmentPaths.ts";
import { isPersistenceError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { PurgeJobRepositoryLive } from "../../persistence/Layers/PurgeJobRepository.ts";
import {
  type PurgeJob,
  PurgeJobRepository,
  type PurgeResource,
} from "../../persistence/Services/PurgeJobRepository.ts";
import { ServerConfig } from "../../startup/config.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { EntityPurge, type EntityPurgeShape } from "../Services/EntityPurge.ts";
import { makeEntityPurgeSql } from "./EntityPurge.sql.ts";

const decodeAttachments = decodeJsonResult(Schema.Array(ChatAttachment));

function managedRelativePath(root: string, target: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : null;
}

function safeEntitySegment(entityId: string): string | null {
  return entityId.length > 0 &&
    entityId !== "." &&
    entityId !== ".." &&
    !entityId.includes("/") &&
    !entityId.includes("\\")
    ? entityId
    : null;
}

function mapPurgeError(operation: string) {
  return (error: unknown) =>
    isPersistenceError(error) ? error : toPersistenceSqlError(operation)(error);
}

const makeEntityPurge = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const jobs = yield* PurgeJobRepository;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const queries = makeEntityPurgeSql(sql);

  const updateJob = (job: PurgeJob, phase: PurgeJob["phase"]) =>
    jobs.update({
      jobId: job.jobId,
      phase,
      status: "running",
      lastError: null,
      updatedAt: new Date().toISOString(),
    });

  const requestThread: EntityPurgeShape["requestThread"] = Effect.fn("EntityPurge.requestThread")(
    function* (threadId: ThreadId) {
      return yield* Effect.gen(function* () {
        const rows = yield* queries.readThreadAssets({ threadId });
        const resources = new Map<string, PurgeResource>();
        for (const row of rows) {
          if (row.attachmentsJson) {
            const decoded = decodeAttachments(row.attachmentsJson);
            if (Result.isSuccess(decoded)) {
              for (const attachment of decoded.success) {
                const relativePath = attachmentRelativePath(attachment);
                if (relativePath) {
                  resources.set(`attachment:${relativePath}`, {
                    kind: "attachment",
                    relativePath,
                  });
                }
              }
            }
          }
          if (row.worktreePath) {
            const relativePath = managedRelativePath(config.worktreesDir, row.worktreePath);
            if (relativePath) {
              resources.set(`managed-worktree:${relativePath}`, {
                kind: "managed-worktree",
                relativePath,
              });
            }
          }
        }
        return yield* jobs.createOrGet({
          jobId: crypto.randomUUID(),
          entityKind: "thread",
          entityId: threadId,
          resourceManifest: Array.from(resources.values()),
          createdAt: new Date().toISOString(),
        });
      }).pipe(Effect.mapError(mapPurgeError("EntityPurge.requestThread")));
    },
  );

  const requestProject: EntityPurgeShape["requestProject"] = Effect.fn(
    "EntityPurge.requestProject",
  )(function* (projectId) {
    const segment = safeEntitySegment(projectId);
    const resourceManifest: Array<PurgeResource> = segment
      ? [
          { kind: "project-memory", relativePath: segment },
          { kind: "project-notes", relativePath: segment },
          { kind: "project-kanban", relativePath: segment },
        ]
      : [];
    return yield* jobs.createOrGet({
      jobId: crypto.randomUUID(),
      entityKind: "project",
      entityId: projectId,
      resourceManifest,
      createdAt: new Date().toISOString(),
    });
  });

  const resolveResourcePath = (resource: PurgeResource): string | null => {
    switch (resource.kind) {
      case "attachment":
        return resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: resource.relativePath,
        });
      case "project-memory":
        return managedRelativePath(
          path.join(config.stateDir, "memory", "projects"),
          path.join(config.stateDir, "memory", "projects", resource.relativePath),
        )
          ? path.join(config.stateDir, "memory", "projects", resource.relativePath)
          : null;
      case "project-notes":
        return managedRelativePath(
          config.notesDir,
          path.join(config.notesDir, resource.relativePath),
        )
          ? path.join(config.notesDir, resource.relativePath)
          : null;
      case "project-kanban":
        return managedRelativePath(
          config.kanbanDir,
          path.join(config.kanbanDir, resource.relativePath),
        )
          ? path.join(config.kanbanDir, resource.relativePath)
          : null;
      case "managed-worktree":
        return managedRelativePath(
          config.worktreesDir,
          path.join(config.worktreesDir, resource.relativePath),
        )
          ? path.join(config.worktreesDir, resource.relativePath)
          : null;
    }
  };

  const deleteResources = (job: PurgeJob) =>
    Effect.forEach(
      job.resourceManifest,
      (resource) => {
        const target = resolveResourcePath(resource);
        return target ? fs.remove(target, { recursive: true, force: true }) : Effect.void;
      },
      { concurrency: 1, discard: true },
    ).pipe(Effect.mapError(mapPurgeError("EntityPurge.deleteResources")));

  const verifyResources = (job: PurgeJob) =>
    Effect.forEach(
      job.resourceManifest,
      (resource) => {
        const target = resolveResourcePath(resource);
        return target ? fs.exists(target) : Effect.succeed(false);
      },
      { concurrency: 1 },
    ).pipe(
      Effect.flatMap((results) =>
        results.some(Boolean)
          ? Effect.fail(
              toPersistenceSqlError("EntityPurge.verifyResources")("managed files remain"),
            )
          : Effect.void,
      ),
      Effect.mapError(mapPurgeError("EntityPurge.verifyResources")),
    );

  const run: EntityPurgeShape["run"] = Effect.fn("EntityPurge.run")(function* (job: PurgeJob) {
    return yield* Effect.gen(function* () {
      const entityId =
        job.entityKind === "thread"
          ? ThreadId.makeUnsafe(job.entityId)
          : ProjectId.makeUnsafe(job.entityId);
      let phase = job.phase;
      yield* updateJob(job, phase);

      if (phase === "awaiting-finalization") {
        const markers = yield* queries.readDeletionMarker({
          entityKind: job.entityKind,
          entityId,
        });
        if (markers[0] === undefined) return;
        phase = "baseline";
        yield* updateJob(job, phase);
      }
      if (phase === "baseline") {
        const markers = yield* queries.readDeletionMarker({
          entityKind: job.entityKind,
          entityId,
        });
        const marker = markers[0];
        if (marker === undefined) return;
        yield* projectionPipeline.ensureVerifiedBaselineThrough(marker.deletionSequence);
        phase = "database";
        yield* updateJob(job, phase);
      }
      if (phase === "database") {
        if (job.entityKind === "thread") {
          yield* queries.deleteThreadDependents({ threadId: entityId as ThreadId });
        } else {
          const projectId = entityId as ProjectId;
          const threads = yield* queries.listProjectThreadIds({ projectId });
          yield* Effect.forEach(
            threads,
            ({ threadId }) => requestThread(threadId).pipe(Effect.flatMap(run)),
            { concurrency: 1, discard: true },
          );
          yield* queries.deleteProjectDependents({ projectId });
        }
        phase = "files";
        yield* updateJob(job, phase);
      }
      if (phase === "files") {
        yield* deleteResources(job);
        phase = "verifying";
        yield* updateJob(job, phase);
      }
      if (phase === "verifying") {
        const remaining =
          job.entityKind === "thread"
            ? yield* queries.countThreadRows({ threadId: entityId as ThreadId })
            : yield* queries.countProjectRows({ projectId: entityId as ProjectId });
        if (remaining.count > 0) {
          return yield* toPersistenceSqlError("EntityPurge.verifyDatabase")(
            `${remaining.count} owned rows remain`,
          );
        }
        yield* verifyResources(job);
        phase = "root";
        yield* updateJob(job, phase);
      }
      if (phase === "root") {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const canonicalProofRows = yield* queries.readCanonicalProof({
              entityKind: job.entityKind,
              entityId,
            });
            const canonicalProof = canonicalProofRows[0] ?? {
              canonicalCount: 0,
              coveredByBaselineSequence: null,
              deletionSequence: null,
              maxCanonicalSequence: 0,
            };
            if (
              canonicalProof.canonicalCount > 0 &&
              (canonicalProof.coveredByBaselineSequence === null ||
                canonicalProof.deletionSequence === null ||
                canonicalProof.deletionSequence > canonicalProof.coveredByBaselineSequence ||
                canonicalProof.maxCanonicalSequence > canonicalProof.coveredByBaselineSequence)
            ) {
              return yield* toPersistenceSqlError("EntityPurge.verifyCanonicalReplay")(
                "entity deletion is not covered by a verified projection baseline",
              );
            }
            yield* queries.deleteProvenReceipts({ entityKind: job.entityKind, entityId });
            if (job.entityKind === "thread") {
              yield* queries.deleteThreadRoot({ threadId: entityId as ThreadId });
            } else {
              yield* queries.deleteProjectRoot({ projectId: entityId as ProjectId });
            }
            yield* jobs.complete({ jobId: job.jobId, completedAt: new Date().toISOString() });
          }),
        );
      }
    }).pipe(
      Effect.mapError(mapPurgeError("EntityPurge.run")),
      Effect.catch((error) =>
        jobs
          .update({
            jobId: job.jobId,
            phase: job.phase,
            status: "failed",
            lastError: error.message,
            updatedAt: new Date().toISOString(),
          })
          .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
      ),
    );
  });

  const auditAndResume: EntityPurgeShape["auditAndResume"] = Effect.fn(
    "EntityPurge.auditAndResume",
  )(function* (requestedLimit: number = 100) {
    return yield* Effect.gen(function* () {
      const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)));
      const incomplete = yield* jobs.listIncomplete(limit);
      yield* Effect.forEach(
        incomplete,
        (job) =>
          run(job).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("entity purge audit job failed", {
                jobId: job.jobId,
                entityKind: job.entityKind,
                entityId: job.entityId,
                phase: job.phase,
                cause,
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      yield* queries.deleteOrphanRows(limit);

      const deletedThreads = yield* queries.listDeletedThreads({ limit });
      yield* Effect.forEach(
        deletedThreads,
        ({ threadId }) => requestThread(threadId).pipe(Effect.flatMap(run)),
        { concurrency: 1, discard: true },
      );
      const deletedProjects = yield* queries.listDeletedProjects({ limit });
      yield* Effect.forEach(
        deletedProjects,
        ({ projectId }) => requestProject(projectId).pipe(Effect.flatMap(run)),
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.mapError(mapPurgeError("EntityPurge.auditAndResume")));
  });

  return { requestThread, requestProject, run, auditAndResume } satisfies EntityPurgeShape;
});

export const EntityPurgeLive = Layer.effect(EntityPurge, makeEntityPurge).pipe(
  Layer.provide(PurgeJobRepositoryLive),
);
