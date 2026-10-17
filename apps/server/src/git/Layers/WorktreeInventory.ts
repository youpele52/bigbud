import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { Effect } from "effect";
import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { WorktreeContext, WorktreeEntry } from "@bigbud/contracts/workspace/worktrees.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";

/** Parse NUL-delimited attributes without trimming or unquoting filesystem names. */
export function parseWorktreeInventory(output: string): WorktreeEntry[] {
  if (!output.endsWith("\0\0")) throw new Error("Incomplete Git worktree inventory.");
  return output
    .slice(0, -2)
    .split("\0\0")
    .map((record, index) => {
      const fields = record.split("\0");
      const first = fields.shift();
      if (!first?.startsWith("worktree ") || first.length === 9)
        throw new Error("Invalid Git worktree inventory.");
      const value = (label: string) =>
        fields.find((field) => field.startsWith(`${label} `))?.slice(label.length + 1) ?? null;
      const flag = (label: string) => fields.includes(label);
      const worktreePath = first.slice(9);
      const branchRef = value("branch");
      return {
        path: worktreePath,
        name:
          (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(worktreePath)
            ? path.win32.basename(worktreePath)
            : path.posix.basename(worktreePath)) || worktreePath,
        branch: branchRef?.startsWith("refs/heads/") ? branchRef.slice(11) : branchRef,
        head: value("HEAD"),
        main: index === 0,
        bare: flag("bare"),
        locked: flag("locked") ? "Locked" : value("locked"),
        prunable: flag("prunable") ? "Unavailable" : value("prunable"),
      };
    });
}

export const worktreeFailure = (cwd: string, detail: string, cause?: unknown) =>
  new GitCommandError({
    operation: "worktree",
    command: "git worktree",
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });

/** Route every observation through GitCore; remote paths never touch the host filesystem. */
export function makeWorktreeInventory(git: Pick<GitCoreShape, "execute">) {
  const run = (input: WorktreeContext, args: string[]) =>
    git
      .execute({
        ...input,
        args,
        operation: "worktree.inventory",
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code !== 0 || result.stdoutTruncated
            ? Effect.fail(
                worktreeFailure(
                  input.cwd,
                  result.stderr || "Git worktree inventory failed or exceeded its limit.",
                ),
              )
            : Effect.succeed(result.stdout),
        ),
      );
  return (input: WorktreeContext) =>
    Effect.gen(function* () {
      const local = isLocalExecutionTarget(input.executionTargetId);
      const common = yield* run(input, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const repository = common.replace(/\r?\n$/, "");
      const raw = yield* run(input, ["worktree", "list", "--porcelain", "-z"]);
      const parsed = yield* Effect.try({
        try: () => parseWorktreeInventory(raw),
        catch: (cause) =>
          worktreeFailure(input.cwd, "Invalid or incomplete Git worktree inventory.", cause),
      });
      const entries = local
        ? yield* Effect.forEach(
            parsed,
            (entry) =>
              Effect.tryPromise({
                try: async () => {
                  try {
                    const canonical = await realpath(entry.path);
                    const identity = await stat(canonical);
                    return {
                      ...entry,
                      path: canonical,
                      name: path.basename(canonical) || canonical,
                      identity: `${identity.dev}:${identity.ino}`,
                    };
                  } catch {
                    return entry;
                  }
                },
                catch: (cause) =>
                  worktreeFailure(input.cwd, "Could not identify worktrees.", cause),
              }),
            { concurrency: 4 },
          )
        : parsed;
      const requested = local
        ? yield* Effect.tryPromise({
            try: () => realpath(input.cwd),
            catch: (cause) =>
              worktreeFailure(input.cwd, "Could not resolve the current checkout.", cause),
          })
        : input.cwd;
      const checkoutPath =
        entries
          .filter(
            (entry) =>
              requested === entry.path ||
              requested.startsWith(entry.path + (local ? path.sep : "/")),
          )
          .toSorted((a, b) => b.path.length - a.path.length)[0]?.path ?? requested;
      const selectedPath = input.selectedPath
        ? local
          ? yield* Effect.promise(() =>
              realpath(input.selectedPath!).catch(() => input.selectedPath!),
            )
          : input.selectedPath
        : undefined;
      return {
        repository: local ? path.resolve(repository) : repository,
        checkoutPath,
        ...(selectedPath ? { selectedPath } : {}),
        entries,
        linkedCount: entries.filter((entry) => !entry.main).length,
        local,
      };
    });
}
