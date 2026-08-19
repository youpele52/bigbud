import * as nodeFs from "node:fs/promises";

import { ProjectId } from "@bigbud/contracts";
import { Effect } from "effect";

import { safeEntitySegment } from "./EntityPurge.assets.ts";
import {
  captureResourceIdentity,
  deleteResourceAtomically,
  resolvePurgeResource,
  resourceRoot,
} from "./EntityPurge.resources.ts";
import type { PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";
import { ServerConfig } from "../../startup/config.ts";

export interface DiscoveredProjectDeletionFiles {
  readonly projectId: ProjectId;
  readonly resources: ReadonlyArray<PurgeResource>;
}

export interface ProjectDeletionOrphanedResource {
  readonly resource: string;
  readonly detail: string;
}

const captureResource = Effect.fn("ProjectDeletion.captureResource")(function* (
  kind: PurgeResource["kind"],
  relativePath: string,
) {
  const config = yield* ServerConfig;
  yield* Effect.tryPromise(() => nodeFs.mkdir(resourceRoot(config, kind), { recursive: true }));
  const resolved = resolvePurgeResource(config, {
    kind,
    relativePath,
    identity: null,
    quarantineName: `.bigbud-purge-${crypto.randomUUID()}`,
    action: "delete",
  });
  return {
    kind,
    relativePath,
    identity: yield* Effect.tryPromise(() => captureResourceIdentity(resolved)),
    quarantineName: `.bigbud-purge-${crypto.randomUUID()}`,
    action: "delete",
  } satisfies PurgeResource;
});

export const discoverProjectDeletionFiles = Effect.fn("ProjectDeletion.discoverFiles")(function* (
  projectId: ProjectId,
) {
  const segment = safeEntitySegment(projectId);
  if (!segment) return yield* Effect.fail(new Error("invalid project id"));
  return {
    projectId,
    resources: yield* Effect.forEach(
      ["project-memory", "project-notes", "project-kanban"] as const,
      (kind) => captureResource(kind, segment),
    ),
  } satisfies DiscoveredProjectDeletionFiles;
});

export const cleanupDiscoveredProjectDeletionFiles = Effect.fn("ProjectDeletion.cleanupFiles")(
  function* (files: DiscoveredProjectDeletionFiles) {
    const config = yield* ServerConfig;
    const results = yield* Effect.forEach(
      files.resources,
      (resource) =>
        Effect.exit(
          Effect.tryPromise(() =>
            deleteResourceAtomically({
              jobId: `project-delete:${files.projectId}`,
              resolved: resolvePurgeResource(config, resource),
              resource,
            }),
          ),
        ).pipe(
          Effect.map((exit) =>
            exit._tag === "Failure"
              ? ({
                  resource: `${resource.kind}:${resource.relativePath}`,
                  detail: String(exit.cause),
                } satisfies ProjectDeletionOrphanedResource)
              : undefined,
          ),
        ),
      { concurrency: 1 },
    );
    return results.filter(
      (result): result is ProjectDeletionOrphanedResource => result !== undefined,
    );
  },
);
