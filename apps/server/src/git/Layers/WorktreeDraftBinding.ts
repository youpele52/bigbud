import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { WorktreeBinding } from "@bigbud/contracts/workspace/worktreeBinding.ts";
import { captureWorktreePathIdentity } from "../../retention/worktreeRuntimeLease.ts";
import { recordedWorktreePathsOverlap } from "../../deletion/Layers/ThreadDeletion.worktreePaths.ts";
import { worktreeFailure } from "./WorktreeInventory.ts";
import { inspectDeclaredCommonDir } from "../../checkpointing/Layers/CheckpointStore.identity.ts";
import { canonicalWorktreePath } from "./WorktreeReferences.ts";

/** Reject stale offline selection, including reused aliases, before a saved owner or runtime is created. */
export function assertWorktreeDraftBinding(
  sql: SqlClient.SqlClient,
  binding: WorktreeBinding,
  path: string | null,
  target: string,
) {
  return Effect.gen(function* () {
    if (
      !path ||
      binding.path !== path ||
      binding.executionTargetId !== target ||
      target !== "local"
    )
      return yield* worktreeFailure(
        binding.path,
        "stale_workspace: draft location or target changed; select the worktree again.",
      );
    const identity = yield* Effect.tryPromise({
      try: () => captureWorktreePathIdentity(path),
      catch: (cause) =>
        worktreeFailure(path, "stale_workspace: draft worktree is no longer available.", cause),
    });
    if (`${identity.device}:${identity.inode}` !== binding.identity)
      return yield* worktreeFailure(
        path,
        "stale_workspace: another folder now occupies the selected path. Select a verified worktree again.",
      );
    const repository = yield* Effect.tryPromise({
      try: () => inspectDeclaredCommonDir(identity.canonicalPath),
      catch: (cause) =>
        worktreeFailure(
          path,
          "stale_workspace: selected Git repository is no longer verifiable.",
          cause,
        ),
    });
    if (repository.canonicalPath !== (yield* canonicalWorktreePath(binding.repository)))
      return yield* worktreeFailure(
        path,
        "stale_workspace: selected directory now belongs to another repository.",
      );
    const [latest] = yield* sql<{
      readonly revision: number;
    }>`SELECT COALESCE(MAX(rowid),0) AS revision FROM worktree_operations WHERE kind <> 'access'`;
    if (binding.revision > (latest?.revision ?? 0))
      return yield* worktreeFailure(
        path,
        "stale_workspace: draft revision belongs to another server state. Select a verified worktree again.",
      );
    const changes = yield* sql<{
      readonly source: string;
      readonly destination: string;
    }>`SELECT source_path AS source, destination_path AS destination
      FROM worktree_operations WHERE kind <> 'access' AND rowid > ${binding.revision} AND phase <> 'rejected'`;
    if (
      changes.some(
        (change) =>
          recordedWorktreePathsOverlap(change.source, identity.canonicalPath) ||
          recordedWorktreePathsOverlap(change.destination, identity.canonicalPath),
      )
    )
      return yield* worktreeFailure(
        path,
        "stale_workspace: selected worktree revision changed while this draft was offline. Select it again.",
      );
  });
}
