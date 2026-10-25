import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { captureWorktreePathIdentity } from "../../retention/worktreeRuntimeLease.ts";
import { worktreeFailure } from "./WorktreeInventory.ts";

/** A replaced or missing checkout cannot start work under an old chat's saved identity. */
export function assertSavedWorktreeIdentity(sql: SqlClient.SqlClient, threadId: string) {
  return Effect.gen(function* () {
    const [row] = yield* sql<{
      readonly path: string;
      readonly device: number | null;
      readonly inode: number | null;
    }>`SELECT worktree_path AS path, worktree_device AS device, worktree_inode AS inode
      FROM projection_threads WHERE thread_id = ${threadId} AND workspace_execution_target_id = 'local'
        AND worktree_path IS NOT NULL AND (
          (worktree_device IS NOT NULL AND worktree_inode IS NOT NULL)
          OR EXISTS (SELECT 1 FROM provider_session_runtime r WHERE r.thread_id = projection_threads.thread_id AND r.resume_cursor_json IS NOT NULL)
          OR EXISTS (SELECT 1 FROM opencode_v2_shared_bindings b WHERE b.thread_id = projection_threads.thread_id))`;
    if (!row) return;
    if (row.device === null || row.inode === null)
      return yield* worktreeFailure(
        row.path,
        "Saved worktree identity is unavailable for retained native history. Nothing was started and no cursor was reset; use a new chat for another workspace.",
      );
    const identity = yield* Effect.tryPromise({
      try: () => captureWorktreePathIdentity(row.path),
      catch: (cause) =>
        worktreeFailure(
          row.path,
          "Saved worktree is unavailable. Refresh the worktree list; history and resume evidence were not changed.",
          cause,
        ),
    });
    if (identity.device !== row.device || identity.inode !== row.inode)
      return yield* worktreeFailure(
        row.path,
        "Saved worktree was replaced. Nothing was started; select a verified workspace in a new chat to preserve native history.",
      );
  });
}
