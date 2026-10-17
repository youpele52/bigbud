import { lstat, readdir } from "node:fs/promises";
import { Effect } from "effect";
import type { GitCoreShape } from "../Services/GitCore.ts";
import type { WorktreeOperationRow } from "./WorktreeReservations.ts";
import { makeWorktreeInventory, worktreeFailure } from "./WorktreeInventory.ts";
import { inspectDeclaredCommonDir } from "../../checkpointing/Layers/CheckpointStore.identity.ts";
import { canonicalWorktreePath } from "./WorktreeReferences.ts";

/** Missing is distinct from inaccessible, replaced, non-directory or symlink entries. */
export const worktreeIdentityAt = (target: string) =>
  Effect.promise(async () => {
    try {
      const value = await lstat(target);
      return value.isDirectory() && !value.isSymbolicLink()
        ? `${value.dev}:${value.ino}`
        : "unsupported-entry";
    } catch (cause) {
      return cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT"
        ? null
        : "identity-unavailable";
    }
  });

/** Only a returned child exit code proves settlement; a transport error or timeout does not. */
export const executeWorktreeGit = (
  git: GitCoreShape,
  cwd: string,
  args: string[],
  onSettled?: (code: number) => void,
) =>
  git
    .execute({
      cwd,
      args,
      operation: "worktree.lifecycle",
      allowNonZeroExit: true,
      maxOutputBytes: 8 * 1024 * 1024,
    })
    .pipe(
      Effect.tap((result) => Effect.sync(() => onSettled?.(result.code))),
      Effect.flatMap((result) =>
        result.code !== 0 || result.stdoutTruncated
          ? Effect.fail(
              worktreeFailure(
                cwd,
                result.stderr || "Git worktree operation failed or its output was truncated.",
              ),
            )
          : Effect.succeed(result.stdout),
      ),
    );

export const readWorktreeStatus = (git: GitCoreShape, cwd: string) =>
  executeWorktreeGit(git, cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);

/** A settled rejection releases the fence only after fresh registration, identity and content-state proof. */
export function proveUnchangedWorktree(
  git: GitCoreShape,
  operation: WorktreeOperationRow,
  previousStatus: string,
) {
  return Effect.gen(function* () {
    const listing = yield* makeWorktreeInventory(git)({ cwd: operation.cwd });
    const source = listing.entries.find((entry) => entry.path === operation.source);
    if (
      listing.repository !== operation.repository ||
      !source ||
      source.main ||
      source.bare ||
      source.locked ||
      source.prunable ||
      source.identity !== `${operation.device}:${operation.inode}` ||
      source.head !== operation.head ||
      source.branch !== operation.branch
    )
      return false;
    if (
      !operation.parentPath ||
      (yield* worktreeIdentityAt(operation.parentPath)) !==
        `${operation.parentDevice}:${operation.parentInode}`
    )
      return false;
    const common = yield* Effect.tryPromise({
      try: () => inspectDeclaredCommonDir(operation.source),
      catch: (cause) =>
        worktreeFailure(operation.cwd, "Could not verify original Git registration.", cause),
    });
    if (common.canonicalPath !== (yield* canonicalWorktreePath(operation.repository))) return false;
    return (yield* readWorktreeStatus(git, operation.source)) === previousStatus;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

/** Failed creation never deletes a branch or directory: an owned empty folder may be retained for inspection. */
export function proveRejectedCreation(git: GitCoreShape, operation: WorktreeOperationRow) {
  return Effect.gen(function* () {
    const listing = yield* makeWorktreeInventory(git)({ cwd: operation.cwd });
    if (
      listing.repository !== operation.repository ||
      listing.entries.some((entry) => entry.path === operation.destination)
    )
      return false;
    if (
      !operation.parentPath ||
      (yield* worktreeIdentityAt(operation.parentPath)) !==
        `${operation.parentDevice}:${operation.parentInode}`
    )
      return false;
    const identity = yield* worktreeIdentityAt(operation.destination);
    if (identity === null) return true;
    if (identity !== `${operation.device}:${operation.inode}`) return false;
    return (
      (yield* Effect.tryPromise({
        try: () => readdir(operation.destination),
        catch: (cause) =>
          worktreeFailure(operation.cwd, "Creation folder could not be inspected.", cause),
      })).length === 0
    );
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}
