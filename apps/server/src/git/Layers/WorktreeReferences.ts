import path from "node:path";
import { realpath } from "node:fs/promises";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import { recordedWorktreePathsOverlap } from "../../deletion/Layers/ThreadDeletion.worktreePaths.ts";
import { worktreeFailure } from "./WorktreeInventory.ts";
import { listRetainedWorktreeProviderContexts } from "./WorktreeProviderContexts.ts";

export interface WorktreeReference {
  readonly threadId: ThreadId;
  readonly worktreePath: string;
  readonly canonicalPath: string | null;
  readonly deletingAt: string | null;
  readonly device: number | null;
  readonly inode: number | null;
}

export const canonicalWorktreePath = (value: string) =>
  Effect.promise(async () => {
    try {
      return await realpath(value);
    } catch {
      return path.resolve(value);
    }
  });

export type WorktreePathResolver = (value: string) => Effect.Effect<string, GitCommandError>;

/** Exhaust all persisted references, including archived chats and aliases in other projects. */
export function listWorktreeReferences(
  sql: SqlClient.SqlClient,
  target: string,
  resolve: WorktreePathResolver = canonicalWorktreePath,
  identity?: { readonly device: number; readonly inode: number },
) {
  return Effect.gen(function* () {
    const references: WorktreeReference[] = [];
    let after = "";
    while (true) {
      const page = yield* sql<WorktreeReference>`SELECT thread_id AS "threadId",
        worktree_path AS "worktreePath", worktree_canonical_path AS "canonicalPath",
        deleting_at AS "deletingAt", worktree_device AS device, worktree_inode AS inode FROM projection_threads
        WHERE workspace_execution_target_id = 'local' AND worktree_path IS NOT NULL
          AND thread_id > ${after} ORDER BY thread_id LIMIT 100`;
      for (const row of page) {
        const canonical = yield* resolve(row.worktreePath);
        if (
          recordedWorktreePathsOverlap(canonical, target) ||
          (row.canonicalPath && recordedWorktreePathsOverlap(row.canonicalPath, target)) ||
          (identity && row.device === identity.device && row.inode === identity.inode)
        )
          references.push(row);
      }
      if (page.length < 100) break;
      after = page.at(-1)!.threadId;
    }
    return references;
  });
}

/** An uncertain runtime is not evidence that filesystem movement is safe. */
export function assertInactiveWorktreeThread(sql: SqlClient.SqlClient, threadId: string) {
  return Effect.gen(function* () {
    const active = yield* sql`SELECT 1 FROM projection_thread_sessions
      WHERE thread_id = ${threadId} AND (status NOT IN ('stopped','error') OR active_turn_id IS NOT NULL)
      UNION ALL SELECT 1 FROM provider_session_runtime
      WHERE thread_id = ${threadId} AND status IN ('starting','running')
      UNION ALL SELECT 1 FROM worktree_runtime_leases WHERE thread_id = ${threadId}
      UNION ALL SELECT 1 FROM thread_activity_leases WHERE thread_id = ${threadId}
      UNION ALL SELECT 1 FROM provider_turn_admissions
      WHERE owner_thread_id = ${threadId} AND state <> 'terminal'
      UNION ALL SELECT 1 FROM projection_turns
      WHERE thread_id = ${threadId} AND state IN ('pending','running')
      UNION ALL SELECT 1 FROM projection_threads WHERE thread_id = ${threadId}
        AND (deleting_at IS NOT NULL OR json_array_length(queued_prompts_json) > 0
          OR pending_turn_control_operation_json IS NOT NULL)
      LIMIT 1`;
    if (active.length)
      return yield* worktreeFailure(
        threadId,
        "Stop the active session, turn, terminal or shell before changing this workspace. Unconfirmed operations must settle first.",
      );
  });
}

/** Native identity is never discarded to manufacture a successful workspace switch. */
export function assertCanChangeWorktreePath(
  sql: SqlClient.SqlClient,
  threadId: string,
  includeUnmaterializedV2 = true,
) {
  return Effect.gen(function* () {
    const retained =
      yield* sql`SELECT 1 FROM opencode_v2_shared_bindings WHERE thread_id = ${threadId}
      UNION ALL SELECT 1 FROM projection_threads WHERE thread_id = ${threadId}
        AND json_extract(model_selection_json, '$.provider') IN ('opencodeV2','opencode')
        AND (${includeUnmaterializedV2 ? 1 : 0} OR EXISTS (SELECT 1 FROM projection_thread_messages m WHERE m.thread_id = ${threadId}))
      UNION ALL SELECT 1 FROM provider_turn_admissions WHERE owner_thread_id = ${threadId}
      UNION ALL SELECT 1 FROM provider_session_runtime WHERE thread_id = ${threadId}
        AND (provider_name = 'opencodeV2' OR resume_cursor_json IS NOT NULL)
      LIMIT 1`;
    if (retained.length) {
      return yield* worktreeFailure(
        threadId,
        "This chat retains provider-native history at its original workspace. Switching or following a moved folder is unsupported; history and resume evidence are unchanged. Use a new chat for another workspace.",
      );
    }
  });
}

/** Native records outlive chats; orphaned admissions and shared bindings still own their directory. */
export function assertNoRetainedWorktreeLocation(
  sql: SqlClient.SqlClient,
  target: string,
  resolve: WorktreePathResolver = canonicalWorktreePath,
) {
  return Effect.gen(function* () {
    const records = yield* listRetainedWorktreeProviderContexts(sql, target, resolve);
    if (records.length)
      return yield* worktreeFailure(
        target,
        "Retained provider-native history references this directory. Nothing was deleted; history and resume evidence are unchanged.",
      );
  });
}
