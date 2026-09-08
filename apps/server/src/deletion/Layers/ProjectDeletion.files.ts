import * as nodeFs from "node:fs/promises";

import { ProjectId } from "@bigbud/contracts";
import { Effect } from "effect";

import { safeEntitySegment } from "./EntityPurge.assets.ts";
import { resolvePurgeResource, resourceRoot } from "./EntityPurge.resources.ts";
import { ServerConfig } from "../../startup/config.ts";
import type { DirectCleanupResource } from "../Services/DirectResourceCleanupExecutor.ts";
import { captureDirectCleanupIdentity } from "./DirectResourceCleanup.identity.ts";

export interface DiscoveredProjectDeletionFiles {
  readonly projectId: ProjectId;
  readonly resources: ReadonlyArray<DirectCleanupResource>;
}

const captureResource = Effect.fn("ProjectDeletion.captureResource")(function* (
  kind: DirectCleanupResource["kind"],
  relativePath: string,
) {
  const config = yield* ServerConfig;
  yield* Effect.tryPromise(() => nodeFs.mkdir(resourceRoot(config, kind), { recursive: true }));
  const root = resolvePurgeResource(config, {
    kind,
    relativePath,
    identity: null,
    quarantineName: null,
    action: "delete",
  }).root;
  return {
    resourceId: `${kind}:${relativePath}`,
    kind,
    root,
    relativePath,
    quarantineName: `.bigbud-cleanup-${crypto.randomUUID()}`,
    ...(yield* Effect.tryPromise(() => captureDirectCleanupIdentity({ root, relativePath }))),
  } satisfies DirectCleanupResource;
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
