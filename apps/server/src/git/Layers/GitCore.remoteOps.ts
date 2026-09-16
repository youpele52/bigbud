import { Cache, Effect } from "effect";
import type { Path } from "effect/Path";
import type { GitCoreShape } from "../Services/GitCore.ts";
import { makeGitHelpers } from "./GitCoreExecutor.ts";
import { makeGitStatusOps } from "./GitStatus.ts";
import { makeGitBranchOps } from "./GitBranches.ts";
import { makeGitWorktreeOps } from "./GitWorktree.ts";
import { makeGitHistoryOps } from "./GitHistory.ts";

/** Cache target-specific operation bundles without capturing a mutable runtime selection. */
export const makeRemoteGitOps = Effect.fn("makeRemoteGitOps")(function* (
  execute: GitCoreShape["execute"] | undefined,
  path: Path,
  worktreesDir: string,
) {
  const cache = yield* Cache.make({
    capacity: 64,
    lookup: (executionTargetId: string) =>
      Effect.gen(function* () {
        const helpers = makeGitHelpers((input) =>
          execute!({
            ...input,
            executionTargetId: input.executionTargetId ?? executionTargetId,
          }),
        );
        const statusOps = yield* makeGitStatusOps(helpers, path);
        return {
          statusOps,
          branchOps: makeGitBranchOps(helpers, statusOps),
          worktreeOps: makeGitWorktreeOps(helpers, statusOps, path, worktreesDir),
          historyOps: makeGitHistoryOps(helpers),
        };
      }),
  });
  return (target: string) => Cache.get(cache, target);
});
