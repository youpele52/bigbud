import path from "node:path";
import * as nodeFs from "node:fs/promises";

import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ThreadAssetRow } from "./EntityPurge.assets.ts";
import {
  captureResourceIdentity,
  managedRelativePath,
  resolvePurgeResource,
  resourceRoot,
  resourcesConflict,
} from "./EntityPurge.resources.ts";
import type { PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";
import { ServerConfig } from "../../startup/config.ts";
import {
  managedWorktreeRelativePath,
  recordedWorktreePathsOverlap,
} from "./ThreadDeletion.worktreePaths.ts";

const captureWorktree = Effect.fn("ThreadDeletion.captureWorktree")(function* (
  relativePath: string,
) {
  const config = yield* ServerConfig;
  yield* Effect.tryPromise(() =>
    nodeFs.mkdir(resourceRoot(config, "managed-worktree"), { recursive: true }),
  );
  const resolved = resolvePurgeResource(config, {
    kind: "managed-worktree",
    relativePath,
    identity: null,
    quarantineName: `.bigbud-purge-${crypto.randomUUID()}`,
    action: "delete",
  });
  const identity = yield* Effect.tryPromise(() => captureResourceIdentity(resolved));
  return {
    kind: "managed-worktree",
    relativePath,
    identity,
    quarantineName: `.bigbud-purge-${crypto.randomUUID()}`,
    action: "delete",
  } satisfies PurgeResource;
});

export const discoverThreadWorktrees = Effect.fn("ThreadDeletion.discoverWorktrees")(
  function* (input: {
    readonly rows: ReadonlyArray<ThreadAssetRow>;
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    const paths = new Map<string, boolean>();
    for (const row of input.rows) {
      if (row.worktreePath === null) continue;
      const local = row.workspaceExecutionTargetId === "local" && row.executionTargetId === "local";
      paths.set(row.worktreePath, local && (paths.get(row.worktreePath) ?? true));
    }
    const resources: Array<PurgeResource> = [];
    const retainedExternalWorktrees: Array<{ resourceId: string; recordedPath: string }> = [];
    for (const [worktreePath, local] of paths) {
      if (!local) {
        retainedExternalWorktrees.push({
          resourceId: `external-worktree:${retainedExternalWorktrees.length}`,
          recordedPath: worktreePath,
        });
        continue;
      }
      const relativePath = managedWorktreeRelativePath(config.worktreesDir, worktreePath);
      if (!relativePath) {
        retainedExternalWorktrees.push({
          resourceId: `external-worktree:${retainedExternalWorktrees.length}`,
          recordedPath: worktreePath,
        });
        continue;
      }
      const resource = yield* captureWorktree(relativePath);
      const others = yield* sql<{
        readonly worktreePath: string;
        readonly workspaceExecutionTargetId: string;
        readonly executionTargetId: string;
      }>`
        SELECT worktree_path AS "worktreePath",
          workspace_execution_target_id AS "workspaceExecutionTargetId",
          execution_target_id AS "executionTargetId"
        FROM projection_threads
        WHERE thread_id NOT IN ${sql.in(input.threadIds)} AND worktree_path IS NOT NULL
      `;
      for (const other of others) {
        const target = path.resolve(config.worktreesDir, relativePath);
        if (recordedWorktreePathsOverlap(target, other.worktreePath))
          return yield* Effect.fail(new Error("managed worktree ownership is shared"));
        const otherRelativePath = managedRelativePath(config.worktreesDir, other.worktreePath);
        if (!otherRelativePath) continue;
        if (other.workspaceExecutionTargetId !== "local" || other.executionTargetId !== "local") {
          continue;
        }
        const otherResource = yield* captureWorktree(otherRelativePath);
        if (
          resourcesConflict(
            { resolved: resolvePurgeResource(config, resource), identity: resource.identity },
            {
              resolved: resolvePurgeResource(config, otherResource),
              identity: otherResource.identity,
            },
          )
        )
          return yield* Effect.fail(new Error("managed worktree ownership is shared"));
      }
      resources.push(resource);
    }
    return { resources, retainedExternalWorktrees };
  },
);
