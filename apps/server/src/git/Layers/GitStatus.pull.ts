import { Effect } from "effect";

import type { GitCommandError } from "@bigbud/contracts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import { gitMutationOperationId, type GitHelpers } from "./GitCoreExecutor.ts";
import { createGitCommandError } from "./GitCoreUtils.ts";
import { fetchThroughSelectedRoute } from "./GitCore.fetchRoute.hosts.ts";

interface CurrentUpstream {
  readonly remoteName: string;
  readonly upstreamRef: string;
}

export interface SelectedPullDependencies {
  readonly statusDetailsLocal: GitCoreShape["statusDetailsLocal"];
  readonly resolveCurrentUpstream: (
    cwd: string,
  ) => Effect.Effect<CurrentUpstream | null, GitCommandError>;
  readonly executeGit: GitHelpers["executeGit"];
  readonly runGitStdout: GitHelpers["runGitStdout"];
}

/**
 * Selected pull: one owner fetch, then an admitted local `merge --ff-only`. Dirty, detached,
 * missing-upstream and diverged states refuse typed; rebase has no admitted recipe at all.
 */
export function makeSelectedPullThroughOwner({
  statusDetailsLocal,
  resolveCurrentUpstream,
  executeGit,
  runGitStdout,
}: SelectedPullDependencies) {
  return Effect.fn("pullThroughSelectedOwner")(function* (
    cwd: string,
    operationId: string | undefined,
  ) {
    const fail = (detail: string) =>
      createGitCommandError("GitCore.pullCurrentBranch", cwd, ["pull", "--ff-only"], detail);
    const details = yield* statusDetailsLocal(cwd);
    const branch = details.branch;
    if (!branch) return yield* fail("Cannot pull from detached HEAD.");
    if (!details.hasUpstream) {
      return yield* fail("Current branch has no upstream configured. Push with upstream first.");
    }
    if (details.hasWorkingTreeChanges) {
      return yield* fail(
        "Cannot pull with uncommitted working tree changes. Commit or stash them first.",
      );
    }
    const upstream = yield* resolveCurrentUpstream(cwd);
    if (!upstream) return yield* fail("Could not resolve the current upstream.");
    const beforeSha = yield* runGitStdout(
      "GitCore.pullCurrentBranch.beforeSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    yield* fetchThroughSelectedRoute(
      {
        cwd,
        remoteName: upstream.remoteName,
        refspecs: [],
        timeoutMs: 30_000,
      },
      runGitStdout,
    );
    // Re-read after the fetch: stale tracking state must not decide divergence or fast-forward.
    const fresh = yield* statusDetailsLocal(cwd);
    if (fresh.aheadCount > 0 && fresh.behindCount > 0) {
      return yield* fail("Cannot fast-forward a diverged branch. Rebase or merge manually.");
    }
    if (fresh.behindCount === 0) {
      return {
        status: "skipped_up_to_date" as const,
        branch,
        upstreamBranch: fresh.upstreamRef,
      };
    }
    yield* executeGit(
      "GitCore.pullCurrentBranch.merge",
      cwd,
      ["merge", "--ff-only", upstream.upstreamRef],
      {
        timeoutMs: 30_000,
        fallbackErrorMessage: "git merge --ff-only failed",
        operationId: gitMutationOperationId(operationId, "pull.merge"),
      },
    );
    const afterSha = yield* runGitStdout(
      "GitCore.pullCurrentBranch.afterSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    const refreshed = yield* statusDetailsLocal(cwd);
    return {
      status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
      branch,
      upstreamBranch: refreshed.upstreamRef,
    } as const;
  });
}
