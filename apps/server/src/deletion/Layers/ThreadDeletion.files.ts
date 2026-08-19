import * as nodeFs from "node:fs/promises";

import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { threadAttachmentRelativePaths, type ThreadAssetRow } from "./EntityPurge.assets.ts";
import { exclusiveOwnedLogNames, readOwnedLogDirectory } from "./EntityPurge.logs.ts";
import {
  captureResourceIdentity,
  deleteResourceAtomically,
  managedRelativePath,
  resolvePurgeResource,
  resourceRoot,
  resourcesConflict,
} from "./EntityPurge.resources.ts";
import type { PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";
import { ServerConfig } from "../../startup/config.ts";

export interface DiscoveredThreadDeletionFiles {
  readonly resources: ReadonlyArray<PurgeResource>;
  readonly rootThreadId: ThreadId;
}

export interface ThreadDeletionOrphanedResource {
  readonly resource: string;
  readonly detail: string;
}

const captureResource = Effect.fn("ThreadDeletion.captureResource")(function* (
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
  const identity = yield* Effect.tryPromise(() => captureResourceIdentity(resolved));
  return {
    kind,
    relativePath,
    identity,
    quarantineName: `.bigbud-purge-${crypto.randomUUID()}`,
    action: "delete",
  } satisfies PurgeResource;
});

/** Captures every external resource before the cascade removes the thread subtree. */
export const discoverThreadDeletionFiles = Effect.fn("ThreadDeletion.discoverFiles")(
  function* (input: {
    readonly rootThreadId: ThreadId;
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    const threadIds = [...new Set(input.threadIds)];
    const rows = yield* sql<ThreadAssetRow>`
    SELECT NULL AS "activityKind", NULL AS "activityPayloadJson",
      messages.attachments_json AS "attachmentsJson", threads.worktree_path AS "worktreePath",
      projects.workspace_root AS "workspaceRoot"
    FROM projection_threads AS threads
    LEFT JOIN projection_projects AS projects ON projects.project_id = threads.project_id
    LEFT JOIN projection_thread_messages AS messages ON messages.thread_id = threads.thread_id
    WHERE threads.thread_id IN ${sql.in(threadIds)}
    UNION ALL
    SELECT activities.kind, activities.payload_json, NULL, NULL, NULL
    FROM projection_thread_activities AS activities
    WHERE activities.thread_id IN ${sql.in(threadIds)}
  `;
    const resources = new Map<string, PurgeResource>();
    for (const relativePath of threadAttachmentRelativePaths(rows)) {
      const attachmentId = relativePath.slice(0, relativePath.lastIndexOf("."));
      const [{ shared } = { shared: 0 }] = yield* sql<{ readonly shared: number }>`
      SELECT EXISTS (
        SELECT 1 FROM projection_thread_attachment_refs
        WHERE thread_id NOT IN ${sql.in(threadIds)} AND attachment_id IN (${attachmentId}, '')
      ) AS shared
    `;
      resources.set(`attachment:${relativePath}`, {
        ...(yield* captureResource("attachment", relativePath)),
        action: shared === 1 ? "retain-shared" : "delete",
      });
    }
    for (const worktreePath of new Set(
      rows.flatMap((row) => (row.worktreePath === null ? [] : [row.worktreePath])),
    )) {
      const relativePath = managedRelativePath(config.worktreesDir, worktreePath);
      if (!relativePath)
        return yield* Effect.fail(new Error("thread worktree is outside the managed root"));
      const resource = yield* captureResource("managed-worktree", relativePath);
      const others = yield* sql<{ readonly worktreePath: string }>`
      SELECT worktree_path AS "worktreePath" FROM projection_threads
      WHERE thread_id NOT IN ${sql.in(threadIds)} AND worktree_path IS NOT NULL
    `;
      for (const other of others) {
        const otherRelativePath = managedRelativePath(config.worktreesDir, other.worktreePath);
        if (!otherRelativePath) continue;
        const otherResource = yield* captureResource("managed-worktree", otherRelativePath);
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
      resources.set(`managed-worktree:${relativePath}`, resource);
    }
    const knownThreadIds = (yield* sql<{ readonly threadId: string }>`
    SELECT thread_id AS "threadId" FROM projection_threads
  `).map((row) => row.threadId);
    for (const [kind, directory, type] of [
      ["provider-log", config.providerLogsDir, "provider"],
      ["terminal-history", config.terminalLogsDir, "terminal"],
    ] as const) {
      const entries = yield* Effect.tryPromise(() => readOwnedLogDirectory(directory));
      for (const threadId of threadIds) {
        for (const relativePath of exclusiveOwnedLogNames({
          entries,
          knownThreadIds,
          threadId,
          type,
        })) {
          resources.set(`${kind}:${relativePath}`, yield* captureResource(kind, relativePath));
        }
      }
    }
    return {
      rootThreadId: input.rootThreadId,
      resources: [...resources.values()],
    } satisfies DiscoveredThreadDeletionFiles;
  },
);

/** File failures are deliberately bounded after the database cascade has committed. */
export const cleanupDiscoveredThreadDeletionFiles = Effect.fn("ThreadDeletion.cleanupFiles")(
  function* (files: DiscoveredThreadDeletionFiles) {
    const config = yield* ServerConfig;
    const results = yield* Effect.forEach(
      files.resources,
      (resource) =>
        resource.action === "retain-shared"
          ? Effect.void
          : Effect.exit(
              Effect.tryPromise(() =>
                deleteResourceAtomically({
                  jobId: `thread-delete:${files.rootThreadId}`,
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
                    } satisfies ThreadDeletionOrphanedResource)
                  : undefined,
              ),
            ),
      { concurrency: 1 },
    );
    return results.flatMap((result) => (result === undefined ? [] : [result]));
  },
);
