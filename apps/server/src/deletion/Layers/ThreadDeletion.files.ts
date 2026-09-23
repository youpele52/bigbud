import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";

import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { threadAttachmentRelativePaths, type ThreadAssetRow } from "./EntityPurge.assets.ts";
import { exclusiveOwnedLogNames, readOwnedLogDirectory } from "./EntityPurge.logs.ts";
import { deleteResourceAtomically, resolvePurgeResource } from "./EntityPurge.resources.ts";
import type { PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";
import { ServerConfig } from "../../startup/config.ts";
import type { DirectCleanupResource } from "../Services/DirectResourceCleanupExecutor.ts";
import { captureDirectCleanupIdentity } from "./DirectResourceCleanup.identity.ts";
import { parseAttachmentIdFromRelativePath } from "../../attachments/attachmentStore.ts";
import { discoverThreadWorktrees } from "./ThreadDeletion.worktrees.ts";

export interface DiscoveredThreadDeletionFiles {
  readonly resources: ReadonlyArray<PurgeResource>;
  readonly directResources: ReadonlyArray<DirectCleanupResource>;
  readonly worktreeResources: ReadonlyArray<PurgeResource>;
  readonly retainedExternalWorktrees: ReadonlyArray<{
    readonly resourceId: string;
    readonly recordedPath: string;
  }>;
  readonly retainedUnverifiedAttachments: ReadonlyArray<{
    readonly resourceId: string;
    readonly relativePath: string;
    readonly reason: string;
  }>;
  readonly retainedResources: ReadonlyArray<{
    readonly resourceId: string;
    readonly kind: "attachment";
    readonly relativePath: string;
  }>;
  readonly rootThreadId: ThreadId;
}

export interface ThreadDeletionOrphanedResource {
  readonly resource: string;
  readonly detail: string;
}

async function lstatIfPresent(filePath: string) {
  try {
    return await nodeFs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    throw error;
  }
}

const captureDirectResource = Effect.fn("ThreadDeletion.captureDirectResource")(function* (
  kind: DirectCleanupResource["kind"],
  relativePath: string,
) {
  const config = yield* ServerConfig;
  const resolved = resolvePurgeResource(config, {
    kind,
    relativePath,
    identity: null,
    quarantineName: null,
    action: "delete",
  });
  const root = resolved.root;
  yield* Effect.tryPromise(() => nodeFs.mkdir(root, { recursive: true }));
  const captured = yield* Effect.tryPromise(() =>
    captureDirectCleanupIdentity({ root, relativePath }),
  );
  return {
    resourceId: `${kind}:${relativePath}`,
    kind,
    root,
    relativePath,
    quarantineName: `.bigbud-cleanup-${crypto.randomUUID()}`,
    ...captured,
  } satisfies DirectCleanupResource;
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
    SELECT messages.message_id AS "sourceId", NULL AS "activityKind", NULL AS "activityPayloadJson",
      messages.attachments_json AS "attachmentsJson", threads.worktree_path AS "worktreePath",
      projects.workspace_root AS "workspaceRoot",
      threads.workspace_execution_target_id AS "workspaceExecutionTargetId",
      threads.execution_target_id AS "executionTargetId"
    FROM projection_threads AS threads
    LEFT JOIN projection_projects AS projects ON projects.project_id = threads.project_id
    LEFT JOIN projection_thread_messages AS messages ON messages.thread_id = threads.thread_id
    WHERE threads.thread_id IN ${sql.in(threadIds)}
    UNION ALL
    SELECT activities.activity_id, activities.kind, activities.payload_json, NULL, NULL, NULL,
      NULL, NULL
    FROM projection_thread_activities AS activities
    WHERE activities.thread_id IN ${sql.in(threadIds)}
  `;
    const resources = new Map<string, PurgeResource>();
    const retainedExternalWorktrees: Array<{ resourceId: string; recordedPath: string }> = [];
    const retainedUnverifiedAttachments: Array<{
      resourceId: string;
      relativePath: string;
      reason: string;
    }> = [];
    const manifestPaths = new Set<string>();
    for (const row of rows) {
      const paths = yield* Effect.try({
        try: () => threadAttachmentRelativePaths([row]),
        catch: () => ({ _tag: "InvalidAttachmentManifest" as const }),
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (paths === null) {
        retainedUnverifiedAttachments.push({
          resourceId: `manifest:${row.sourceId ?? input.rootThreadId}`,
          relativePath: "",
          reason: "manifest_invalid",
        });
      } else for (const relativePath of paths) manifestPaths.add(relativePath);
    }
    for (const relativePath of manifestPaths) {
      const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
      if (!attachmentId) {
        retainedUnverifiedAttachments.push({
          resourceId: `attachment:${relativePath}`,
          relativePath,
          reason: "invalid_attachment_id",
        });
        continue;
      }
      const ownership = (yield* sql<{
        relativePath: string;
        creatorThreadId: string;
        lifecycle: string;
        fileDevice: string | null;
        fileId: string | null;
        contentSha256: string;
        sizeBytes: number;
      }>`
        SELECT relative_path AS "relativePath", creator_thread_id AS "creatorThreadId",
          lifecycle, file_device AS "fileDevice", file_id AS "fileId",
          content_sha256 AS "contentSha256", size_bytes AS "sizeBytes"
        FROM managed_attachment_ownership WHERE attachment_id = ${attachmentId}
      `)[0];
      const resourceId = `attachment:${relativePath}`;
      if (
        !ownership ||
        ownership.relativePath !== relativePath ||
        ownership.lifecycle !== "published" ||
        ownership.fileDevice === null ||
        ownership.fileId === null
      ) {
        retainedUnverifiedAttachments.push({
          resourceId,
          relativePath,
          reason: "ownership_unverified",
        });
        continue;
      }
      const filePath = resolvePurgeResource(config, {
        kind: "attachment",
        relativePath,
        identity: null,
        quarantineName: null,
        action: "delete",
      }).target;
      const current = yield* Effect.tryPromise(() => lstatIfPresent(filePath));
      if (
        current &&
        (!current.isFile() ||
          current.dev.toString() !== ownership.fileDevice ||
          current.ino.toString() !== ownership.fileId ||
          current.size !== BigInt(ownership.sizeBytes))
      ) {
        retainedUnverifiedAttachments.push({
          resourceId,
          relativePath,
          reason: "identity_changed",
        });
        continue;
      }
      if (current) {
        const bytes = yield* Effect.tryPromise(() => nodeFs.readFile(filePath));
        if (createHash("sha256").update(bytes).digest("hex") !== ownership.contentSha256) {
          retainedUnverifiedAttachments.push({
            resourceId,
            relativePath,
            reason: "content_changed",
          });
          continue;
        }
      }
      const [{ shared } = { shared: 0 }] = yield* sql<{ readonly shared: number }>`
      SELECT EXISTS (
        SELECT 1 FROM projection_thread_attachment_refs AS ref
        JOIN projection_threads AS live ON live.thread_id = ref.thread_id
        WHERE ref.thread_id NOT IN ${sql.in(threadIds)} AND live.deleted_at IS NULL
          AND ref.attachment_id IN (${attachmentId}, '')
        UNION ALL
        SELECT 1 FROM managed_attachment_references AS ref
        JOIN projection_threads AS live ON live.thread_id = ref.thread_id
        WHERE ref.thread_id NOT IN ${sql.in(threadIds)} AND live.deleted_at IS NULL
          AND ref.attachment_id = ${attachmentId} AND ref.active = 1
      ) AS shared
    `;
      resources.set(`attachment:${relativePath}`, {
        kind: "attachment",
        relativePath,
        identity: null,
        quarantineName: null,
        action: shared === 1 ? "retain-shared" : "delete",
      });
    }
    const owned = yield* sql<{ attachmentId: string; relativePath: string }>`
      SELECT attachment_id AS "attachmentId", relative_path AS "relativePath"
      FROM managed_attachment_ownership WHERE creator_thread_id IN ${sql.in(threadIds)}
    `;
    for (const row of owned) {
      if (!manifestPaths.has(row.relativePath))
        retainedUnverifiedAttachments.push({
          resourceId: `attachment:${row.relativePath}`,
          relativePath: row.relativePath,
          reason: "manifest_missing",
        });
    }
    const worktrees = yield* discoverThreadWorktrees({ rows, threadIds });
    retainedExternalWorktrees.push(...worktrees.retainedExternalWorktrees);
    for (const resource of worktrees.resources)
      resources.set(`managed-worktree:${resource.relativePath}`, resource);
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
          resources.set(`${kind}:${relativePath}`, {
            kind,
            relativePath,
            identity: null,
            quarantineName: null,
            action: "delete",
          });
        }
      }
    }
    const allResources = [...resources.values()];
    const directResources = yield* Effect.forEach(
      allResources.filter(
        (resource): resource is PurgeResource & { kind: DirectCleanupResource["kind"] } =>
          resource.kind !== "managed-worktree" && resource.action === "delete",
      ),
      (resource) => captureDirectResource(resource.kind, resource.relativePath),
      { concurrency: 1 },
    );
    return {
      rootThreadId: input.rootThreadId,
      resources: allResources,
      directResources,
      worktreeResources: allResources.filter((resource) => resource.kind === "managed-worktree"),
      retainedExternalWorktrees,
      retainedUnverifiedAttachments,
      retainedResources: allResources.flatMap((resource) =>
        resource.kind === "attachment" && resource.action === "retain-shared"
          ? [
              {
                resourceId: `attachment:${resource.relativePath}`,
                kind: "attachment" as const,
                relativePath: resource.relativePath,
              },
            ]
          : [],
      ),
    } satisfies DiscoveredThreadDeletionFiles;
  },
);

/** Managed-worktree failures are deliberately bounded after the database cascade has committed. */
export const cleanupDiscoveredThreadWorktrees = Effect.fn("ThreadDeletion.cleanupWorktrees")(
  function* (files: DiscoveredThreadDeletionFiles) {
    const config = yield* ServerConfig;
    const results = yield* Effect.forEach(
      files.worktreeResources,
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
