import { Effect } from "effect";

import type { GitHelpers } from "./GitCoreExecutor.ts";
import { parseNumstatEntries } from "./GitCoreUtils.ts";

/** Bounded per-file count so one status refresh cannot stat an unbounded tree. */
export const MAX_UNTRACKED_COUNT_PATHS = 32;

export type UntrackedLineCount =
  | { readonly counted: true; readonly insertions: number; readonly deletions: number }
  | { readonly counted: false; readonly reason: "binary" | "unavailable" | "bound" };

export interface MakeUntrackedLineCounterInput {
  readonly executeGit: GitHelpers["executeGit"];
  readonly operationPrefix: "GitCore.statusDetails" | "GitCore.statusDetailsLocal";
  readonly limit?: number;
}

/**
 * Count lines for at most `limit` untracked paths through the fixed `git diff --no-index`
 * recipe. A binary, failed or over-limit path is reported as not counted rather than as zero;
 * callers must not present that value as an accurate count.
 */
export function makeUntrackedLineCounter({
  executeGit,
  operationPrefix,
  limit = MAX_UNTRACKED_COUNT_PATHS,
}: MakeUntrackedLineCounterInput) {
  const countOne = Effect.fn("countOneUntrackedPath")(function* (
    cwd: string,
    relativePath: string,
  ) {
    const args = [
      "diff",
      "--numstat",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "/dev/null",
      "--",
      relativePath,
    ] as const;
    const result = yield* executeGit(`${operationPrefix}.fallbackNumstat`, cwd, args, {
      allowNonZeroExit: true,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (result === null || (result.code !== 0 && result.code !== 1)) {
      return { counted: false, reason: "unavailable" } as const;
    }
    const line = result.stdout.split(/\r?\n/g).find((entry) => entry.startsWith("-\t-"));
    if (line !== undefined) return { counted: false, reason: "binary" } as const;
    const entry = parseNumstatEntries(result.stdout).find(
      (candidate) => candidate.path === relativePath,
    );
    if (!entry) return { counted: false, reason: "unavailable" } as const;
    return { counted: true, insertions: entry.insertions, deletions: entry.deletions } as const;
  });

  const countUntrackedPaths = Effect.fn("countUntrackedPaths")(function* (
    cwd: string,
    paths: ReadonlyArray<string>,
  ) {
    const counts = new Map<string, UntrackedLineCount>();
    for (const [index, relativePath] of paths.entries()) {
      const count: UntrackedLineCount =
        index >= limit ? { counted: false, reason: "bound" } : yield* countOne(cwd, relativePath);
      counts.set(relativePath, count);
    }
    return counts;
  });

  return { countUntrackedPaths };
}
