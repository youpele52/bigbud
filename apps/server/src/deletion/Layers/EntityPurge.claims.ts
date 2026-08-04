import * as nodeFs from "node:fs/promises";
import nodePath from "node:path";

import { ThreadId } from "@bigbud/contracts";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";
import { Data, Effect, Result } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { purgeManifestDigest } from "../../persistence/PurgeManifest.ts";
import type {
  PurgeJob,
  PurgeJobRepositoryShape,
  PurgeResource,
} from "../../persistence/Services/PurgeJobRepository.ts";
import { PurgeResourceManifest } from "../../persistence/Services/PurgeJobRepository.ts";
import type { ServerConfigShape } from "../../startup/config.ts";
import {
  assertManifestResourceKind,
  captureResourceIdentity,
  managedRelativePath,
  resolvePurgeResource,
  resourcesConflict,
} from "./EntityPurge.resources.ts";
import { assertOwnedLogName } from "./EntityPurge.logs.ts";
import type { makeEntityPurgeSql } from "./EntityPurge.sql.ts";

const decodeResourceManifest = decodeJsonResult(PurgeResourceManifest);

class WorktreeOwnershipInspectionError extends Data.TaggedError(
  "WorktreeOwnershipInspectionError",
)<{
  readonly cause: unknown;
}> {}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}${nodePath.sep}`) ||
    right.startsWith(`${left}${nodePath.sep}`)
  );
}

export function makeEntityPurgeClaims(input: {
  readonly config: ServerConfigShape;
  readonly queries: ReturnType<typeof makeEntityPurgeSql>;
  readonly captureResource: (
    kind: PurgeResource["kind"],
    relativePath: string,
  ) => Effect.Effect<PurgeResource, ProjectionRepositoryError>;
  readonly resourceOperation: <A>(
    operation: string,
    run: () => Promise<A>,
  ) => Effect.Effect<A, ProjectionRepositoryError>;
  readonly jobs: PurgeJobRepositoryShape;
  readonly sql: SqlClient.SqlClient;
}) {
  const { config, queries, captureResource, resourceOperation, jobs, sql } = input;
  const assertWorktreeExclusive = Effect.fn("EntityPurge.assertWorktreeExclusive")(function* (
    threadId: ThreadId,
    resource: PurgeResource,
  ) {
    const owned = { resolved: resolvePurgeResource(config, resource), identity: resource.identity };
    const otherWorktrees = yield* queries.listOtherThreadWorktrees({ threadId });
    for (const other of otherWorktrees) {
      const relativePath = managedRelativePath(config.worktreesDir, other.worktreePath);
      if (!relativePath) {
        const outsideIdentity = yield* Effect.tryPromise({
          try: async () => {
            try {
              const canonicalPath = await nodeFs.realpath(other.worktreePath);
              const stats = await nodeFs.lstat(canonicalPath);
              return { canonicalPath, device: stats.dev, inode: stats.ino };
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                (error.code === "ENOENT" || error.code === "ENOTDIR")
              ) {
                return null;
              }
              throw error;
            }
          },
          catch: (cause) => new WorktreeOwnershipInspectionError({ cause }),
        });
        if (
          outsideIdentity !== null &&
          resource.identity !== null &&
          (pathsOverlap(resource.identity.canonicalPath, outsideIdentity.canonicalPath) ||
            (resource.identity.device === outsideIdentity.device &&
              resource.identity.inode === outsideIdentity.inode))
        ) {
          return yield* Effect.fail(new Error("managed worktree ownership is shared"));
        }
        continue;
      }
      const otherResource = yield* captureResource("managed-worktree", relativePath);
      if (
        resourcesConflict(owned, {
          resolved: resolvePurgeResource(config, otherResource),
          identity: otherResource.identity,
        })
      )
        return yield* Effect.fail(new Error("managed worktree ownership is shared"));
    }
    const liveIdentities = yield* queries.listLiveWorktreeIdentities({ threadId });
    for (const live of liveIdentities) {
      if (
        resource.identity !== null &&
        (pathsOverlap(owned.resolved.target, live.canonicalPath) ||
          pathsOverlap(resource.identity.canonicalPath, live.canonicalPath) ||
          (resource.identity.device === live.device && resource.identity.inode === live.inode))
      ) {
        return yield* Effect.fail(new Error("managed worktree has an active runtime lease"));
      }
    }
    const manifests = yield* queries.listIncompleteThreadManifests({ threadId });
    for (const manifestRow of manifests) {
      const decoded = decodeResourceManifest(manifestRow.resourceManifestJson);
      if (Result.isFailure(decoded))
        return yield* Effect.fail(new Error("another purge manifest is invalid"));
      for (const otherResource of decoded.success) {
        if (otherResource.kind !== "managed-worktree") continue;
        if (
          resourcesConflict(owned, {
            resolved: resolvePurgeResource(config, otherResource),
            identity: otherResource.identity,
          })
        )
          return yield* Effect.fail(
            new Error("managed worktree ownership is shared by purge jobs"),
          );
      }
    }
  });

  const assertResourceExclusive = Effect.fn("EntityPurge.assertResourceExclusive")(function* (
    job: PurgeJob,
    resource: PurgeResource,
  ) {
    assertManifestResourceKind(job, resource);
    if (job.entityKind !== "thread") return;
    const threadId = ThreadId.makeUnsafe(job.entityId);
    if (resource.kind === "managed-worktree") {
      yield* assertWorktreeExclusive(threadId, resource);
    }
    if (
      resource.kind === "attachment" &&
      resource.identity === null &&
      resource.action === "retain-shared"
    ) {
      return yield* Effect.fail(new Error("missing attachment cannot be retained as shared"));
    }
    if (resource.kind === "provider-log" || resource.kind === "terminal-history") {
      const type = resource.kind === "provider-log" ? "provider" : "terminal";
      const directory =
        resource.kind === "provider-log" ? config.providerLogsDir : config.terminalLogsDir;
      const entries = yield* resourceOperation("EntityPurge.readOwnedLogDirectory", () =>
        nodeFs.readdir(directory).catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return [];
          }
          throw error;
        }),
      );
      const knownThreadIds = (yield* queries.listKnownThreadIds()).map((row) => row.threadId);
      assertOwnedLogName({
        entries,
        knownThreadIds,
        relativePath: resource.relativePath,
        threadId,
        type,
      });
    }
  });

  const bindLegacyManifest = Effect.fn("EntityPurge.bindLegacyManifest")(function* (job: PurgeJob) {
    let changed = false;
    const resources = yield* Effect.forEach(
      job.resourceManifest,
      (resource) =>
        Effect.gen(function* () {
          if (
            resource.identity !== null &&
            resource.identity.root !== null &&
            resource.identity.parent !== null &&
            resource.quarantineName !== null
          ) {
            return resource;
          }
          yield* assertResourceExclusive(job, resource);
          const captured = yield* resourceOperation("EntityPurge.bindLegacyManifest", () =>
            captureResourceIdentity(resolvePurgeResource(config, resource)),
          );
          if (resource.identity === null && captured !== null) {
            return yield* Effect.fail(
              new Error("legacy purge resource was absent and cannot bind a replacement"),
            );
          }
          if (
            resource.identity !== null &&
            (captured === null ||
              captured.canonicalPath !== resource.identity.canonicalPath ||
              captured.device !== resource.identity.device ||
              captured.inode !== resource.identity.inode ||
              captured.type !== resource.identity.type)
          ) {
            return yield* Effect.fail(new Error("legacy purge resource identity is ambiguous"));
          }
          changed = true;
          return {
            ...resource,
            identity: captured,
            quarantineName: resource.quarantineName ?? `.bigbud-purge-${crypto.randomUUID()}`,
          } satisfies PurgeResource;
        }),
      { concurrency: 1 },
    );
    if (!changed) return job;
    const updatedAt = new Date().toISOString();
    const bound = yield* jobs.bindManifest({
      jobId: job.jobId,
      expectedManifestJson: JSON.stringify(job.resourceManifest),
      expectedUpdatedAt: job.updatedAt,
      resourceManifest: resources,
      updatedAt,
    });
    if (!bound)
      return yield* Effect.fail(new Error("purge manifest identity binding was rejected"));
    return { ...job, resourceManifest: resources, updatedAt } satisfies PurgeJob;
  });

  const attachmentIsShared = Effect.fn("EntityPurge.attachmentIsShared")(function* (
    threadId: ThreadId,
    resource: PurgeResource,
  ) {
    const attachmentId = resource.relativePath.slice(0, resource.relativePath.lastIndexOf("."));
    const { shared } = yield* queries.attachmentIsShared({ threadId, attachmentId });
    return shared === 1;
  });

  const assertResourceClaims = Effect.fn("EntityPurge.assertResourceClaims")(function* (
    job: PurgeJob,
  ) {
    const digest = purgeManifestDigest(job.resourceManifest);
    if (job.manifestSealedAt === null || job.manifestDigest !== digest) {
      return yield* Effect.fail(new Error("purge manifest is not sealed with its current digest"));
    }
    const rows = yield* sql<{
      readonly resourceKind: PurgeResource["kind"];
      readonly relativePath: string;
      readonly canonicalPath: string;
      readonly device: number;
      readonly inode: number;
      readonly resourceType: "file" | "directory";
    }>`
      SELECT resource_kind AS "resourceKind", relative_path AS "relativePath",
        canonical_path AS "canonicalPath", device, inode, resource_type AS "resourceType"
      FROM purge_resource_claims WHERE job_id = ${job.jobId}
      ORDER BY resource_kind, relative_path
    `;
    const expected = job.resourceManifest
      .filter((resource) => resource.identity !== null)
      .map((resource) => ({
        resourceKind: resource.kind,
        relativePath: resource.relativePath,
        canonicalPath: resource.identity!.canonicalPath,
        device: resource.identity!.device,
        inode: resource.identity!.inode,
        resourceType: resource.identity!.type,
      }))
      .toSorted(
        (left, right) =>
          left.resourceKind.localeCompare(right.resourceKind) ||
          left.relativePath.localeCompare(right.relativePath),
      );
    if (JSON.stringify(rows) !== JSON.stringify(expected)) {
      return yield* Effect.fail(new Error("purge resource claims do not match the manifest"));
    }
  });

  const acquireResourceClaims = Effect.fn("EntityPurge.acquireResourceClaims")(function* (
    job: PurgeJob,
  ) {
    return yield* Effect.uninterruptible(
      sql.withTransaction(
        Effect.gen(function* () {
          if (job.entityKind === "thread") {
            const active = yield* queries.countThreadRuntimes({
              threadId: ThreadId.makeUnsafe(job.entityId),
            });
            if (active.count > 0) {
              return yield* Effect.fail(new Error("thread has an active durable activity lease"));
            }
          }
          yield* Effect.forEach(
            job.resourceManifest,
            (resource) => assertResourceExclusive(job, resource),
            { concurrency: 1, discard: true },
          );
          let claimedJob = job;
          if (job.entityKind === "thread") {
            const threadId = ThreadId.makeUnsafe(job.entityId);
            const resourceManifest = yield* Effect.forEach(
              job.resourceManifest,
              (resource) =>
                resource.kind === "attachment"
                  ? attachmentIsShared(threadId, resource).pipe(
                      Effect.map((shared) => ({
                        ...resource,
                        action: shared ? ("retain-shared" as const) : ("delete" as const),
                      })),
                    )
                  : Effect.succeed(resource),
              { concurrency: 1 },
            );
            if (JSON.stringify(resourceManifest) !== JSON.stringify(job.resourceManifest)) {
              const updatedAt = new Date().toISOString();
              const bound = yield* jobs.bindManifest({
                jobId: job.jobId,
                expectedManifestJson: JSON.stringify(job.resourceManifest),
                expectedUpdatedAt: job.updatedAt,
                resourceManifest,
                updatedAt,
              });
              if (!bound) {
                return yield* Effect.fail(new Error("purge manifest changed during claim"));
              }
              claimedJob = { ...job, resourceManifest, updatedAt };
            }
          }
          const claimedAt = new Date().toISOString();
          yield* jobs.claimResources({
            jobId: claimedJob.jobId,
            entityKind: claimedJob.entityKind,
            entityId: claimedJob.entityId,
            resourceManifest: claimedJob.resourceManifest,
            claimedAt,
          });
          const sealedJob = {
            ...claimedJob,
            manifestDigest: purgeManifestDigest(claimedJob.resourceManifest),
            manifestSealedAt: claimedJob.manifestSealedAt ?? claimedAt,
          } satisfies PurgeJob;
          yield* assertResourceClaims(sealedJob);
          return sealedJob;
        }),
      ),
    );
  });

  return {
    assertWorktreeExclusive,
    assertResourceExclusive,
    bindLegacyManifest,
    attachmentIsShared,
    assertResourceClaims,
    acquireResourceClaims,
  };
}
