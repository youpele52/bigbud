import { stat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId, type ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { WorktreeInventory } from "@bigbud/contracts/workspace/worktrees.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  assertCanChangeWorktreePath,
  assertInactiveWorktreeThread,
  canonicalWorktreePath,
} from "./WorktreeReferences.ts";

/** Follow only an exact saved filesystem identity. Native history and active owners remain untouched. */
export function reconcileExternalWorktreeChanges(
  sql: SqlClient.SqlClient,
  engine: OrchestrationEngineShape,
  listing: WorktreeInventory,
) {
  return Effect.gen(function* () {
    const issues: string[] = [];
    if (!listing.local) return issues;
    const threads = yield* sql<{
      readonly threadId: ThreadId;
      readonly path: string;
      readonly root: string;
      readonly device: number | null;
      readonly inode: number | null;
    }>`SELECT t.thread_id AS "threadId", t.worktree_path AS path, p.workspace_root AS root,
      t.worktree_device AS device, t.worktree_inode AS inode FROM projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.workspace_execution_target_id = 'local' AND t.worktree_path IS NOT NULL
        AND t.deleted_at IS NULL AND p.workspace_root IS NOT NULL`;
    for (const thread of threads) {
      const root = yield* canonicalWorktreePath(thread.root);
      if (
        !listing.entries.some(
          (entry) => entry.path === root || root.startsWith(entry.path + path.sep),
        )
      )
        continue;
      const previous = yield* Effect.promise(() =>
        stat(thread.path)
          .then((value) => `${value.dev}:${value.ino}`)
          .catch(() => null),
      );
      const saved =
        thread.device !== null && thread.inode !== null
          ? `${thread.device}:${thread.inode}`
          : undefined;
      if (previous && (!saved || previous === saved)) {
        const canonical = yield* canonicalWorktreePath(thread.path);
        if (!listing.entries.some((entry) => canonical === entry.path))
          issues.push(
            `Chat ${thread.threadId}: workspace ${thread.path} is not a registered worktree root; its association and history were retained.`,
          );
        continue;
      }
      const matches = saved ? listing.entries.filter((entry) => entry.identity === saved) : [];
      const destination = matches.length === 1 ? matches[0] : undefined;
      if (
        previous ||
        !destination ||
        destination.main ||
        destination.bare ||
        destination.locked ||
        destination.prunable
      ) {
        issues.push(
          `Chat ${thread.threadId}: workspace ${thread.path} is missing or replaced; no association or history was changed.`,
        );
        continue;
      }
      const result = yield* Effect.gen(function* () {
        // Preflight without a command receipt: unsupported native history must not
        // generate a fresh rejected command on every inventory poll.
        yield* assertInactiveWorktreeThread(sql, thread.threadId);
        yield* assertCanChangeWorktreePath(sql, thread.threadId, false);
        return yield* engine.dispatch(
          {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`external-worktree-${crypto.randomUUID()}`),
            threadId: thread.threadId,
            worktreePath: destination.path,
            branch: destination.branch,
          },
          {
            expectedWorktreePath: { value: thread.path },
            expectedWorktreeIdentity: { path: destination.path, identity: saved! },
          },
        );
      }).pipe(Effect.result);
      if (result._tag === "Failure")
        issues.push(
          `Chat ${thread.threadId}: moved workspace detected at ${destination.path}, but its association was retained: ${String(result.failure)}`,
        );
    }
    return issues;
  });
}
