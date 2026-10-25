import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { captureWorktreePathIdentity } from "../../retention/worktreeRuntimeLease.ts";

/** Ordinary metadata writes must not adopt a replacement folder or erase a missing checkout's identity. */
export function resolveProjectionWorktreeIdentity(
  sql: SqlClient.SqlClient,
  threadId: string,
  worktreePath: string | null,
) {
  return Effect.gen(function* () {
    if (worktreePath === null) return null;
    const [saved] = yield* sql<{
      readonly canonicalPath: string;
      readonly device: number;
      readonly inode: number;
    }>`SELECT worktree_canonical_path AS "canonicalPath", worktree_device AS device, worktree_inode AS inode
      FROM projection_threads WHERE thread_id = ${threadId} AND worktree_path = ${worktreePath}
        AND worktree_canonical_path IS NOT NULL AND worktree_device IS NOT NULL AND worktree_inode IS NOT NULL`;
    if (saved) return saved;
    return yield* Effect.tryPromise({
      try: () => captureWorktreePathIdentity(worktreePath),
      catch: () => null,
    });
  });
}
