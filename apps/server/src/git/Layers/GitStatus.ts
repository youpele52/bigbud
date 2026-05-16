/**
 * GitStatus - Status, upstream refresh, commit, push, and pull operations.
 *
 * @module GitStatus
 */
import { Effect, Path } from "effect";

import { type GitCoreShape } from "../Services/GitCore.ts";
import { type GitHelpers } from "./GitCoreExecutor.ts";
import { createGitCommandError, isMissingGitCwdError } from "./GitCoreUtils.ts";
import { makeRemoteOps } from "./GitStatus.remotes.ts";
import { makeUpstreamOps } from "./GitStatus.upstream.ts";
import { makeCommitOps } from "./GitStatus.commit.ts";
import { makeReadStatusDetails } from "./GitStatus.details.ts";

export interface GitStatusOps {
  statusDetails: GitCoreShape["statusDetails"];
  statusDetailsLocal: GitCoreShape["statusDetailsLocal"];
  status: GitCoreShape["status"];
  prepareCommitContext: GitCoreShape["prepareCommitContext"];
  commit: GitCoreShape["commit"];
  pushCurrentBranch: GitCoreShape["pushCurrentBranch"];
  pullCurrentBranch: GitCoreShape["pullCurrentBranch"];
  readRangeContext: GitCoreShape["readRangeContext"];
  readConfigValue: GitCoreShape["readConfigValue"];
}

export const makeGitStatusOps = Effect.fn("makeGitStatusOps")(function* (
  helpers: GitHelpers,
  path: Path.Path,
) {
  const { executeGit, runGit, runGitStdout } = helpers;

  const remoteOps = makeRemoteOps(helpers, path);
  const upstreamOps = yield* makeUpstreamOps(helpers, path, remoteOps);
  const { prepareCommitContext, commit, readRangeContext, readConfigValue } =
    makeCommitOps(helpers);

  const {
    originRemoteExists,
    branchExists,
    remoteBranchExists,
    resolvePrimaryRemoteName,
    resolvePushRemoteName,
  } = remoteOps;
  const {
    resolveCurrentUpstream,
    refreshStatusUpstreamIfStale,
    resolveBaseBranchForNoUpstream,
    computeAheadCountAgainstBase,
  } = upstreamOps;
  const readStatusDetails = makeReadStatusDetails({
    executeGit,
    runGitStdout,
    originRemoteExists,
    computeAheadCountAgainstBase,
  });

  const statusDetails: GitCoreShape["statusDetails"] = Effect.fn("statusDetails")(function* (cwd) {
    yield* refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchIf(isMissingGitCwdError, () => Effect.void),
      Effect.ignoreCause({ log: true }),
    );
    return yield* readStatusDetails(cwd, "GitCore.statusDetails");
  });

  /**
   * Like `statusDetails` but skips the upstream fetch refresh — reads only local state.
   * Used by the broadcaster to publish low-latency local status without triggering
   * a remote fetch on every call.
   */
  const statusDetailsLocal: GitCoreShape["statusDetailsLocal"] = Effect.fn("statusDetailsLocal")(
    function* (cwd) {
      return yield* readStatusDetails(cwd, "GitCore.statusDetailsLocal");
    },
  );

  const status: GitCoreShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasOriginRemote: details.hasOriginRemote,
        isDefaultBranch: details.isDefaultBranch,
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
      })),
    );

  const pushCurrentBranch: GitCoreShape["pushCurrentBranch"] = Effect.fn("pushCurrentBranch")(
    function* (cwd, fallbackBranch) {
      const details = yield* statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }

      const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
      if (hasNoLocalDelta) {
        if (details.hasUpstream) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
            ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
          };
        }

        const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (comparableBaseBranch) {
          const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (!publishRemoteName) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }

          const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
            Effect.catch(() => Effect.succeed(false)),
          );
          if (hasRemoteBranch) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }
        }
      }

      if (!details.hasUpstream) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
        if (!publishRemoteName) {
          return yield* createGitCommandError(
            "GitCore.pushCurrentBranch",
            cwd,
            ["push"],
            "Cannot push because no git remote is configured for this repository.",
          );
        }
        yield* runGit("GitCore.pushCurrentBranch.pushWithUpstream", cwd, [
          "push",
          "-u",
          publishRemoteName,
          `HEAD:refs/heads/${branch}`,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${publishRemoteName}/${branch}`,
          setUpstream: true,
        };
      }

      const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (currentUpstream) {
        yield* runGit("GitCore.pushCurrentBranch.pushUpstream", cwd, [
          "push",
          currentUpstream.remoteName,
          `HEAD:${currentUpstream.upstreamBranch}`,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: currentUpstream.upstreamRef,
          setUpstream: false,
        };
      }

      yield* runGit("GitCore.pushCurrentBranch.push", cwd, ["push"]);
      return {
        status: "pushed" as const,
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        setUpstream: false,
      };
    },
  );

  const pullCurrentBranch: GitCoreShape["pullCurrentBranch"] = Effect.fn("pullCurrentBranch")(
    function* (cwd) {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Cannot pull from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Current branch has no upstream configured. Push with upstream first.",
        );
      }
      const beforeSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.beforeSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      yield* executeGit("GitCore.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
        timeoutMs: 30_000,
        fallbackErrorMessage: "git pull failed",
      });
      const afterSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.afterSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const refreshed = yield* statusDetails(cwd);
      return {
        status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        branch,
        upstreamBranch: refreshed.upstreamRef,
      };
    },
  );

  return {
    statusDetails,
    statusDetailsLocal,
    status,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    readConfigValue,
    // Expose helpers needed by other modules
    originRemoteExists,
    branchExists,
    remoteBranchExists,
    resolvePrimaryRemoteName,
    resolveCurrentUpstream,
    resolvePushRemoteName,
    resolveBaseBranchForNoUpstream,
  };
});

export type GitStatusOpsResult =
  Awaited<ReturnType<typeof makeGitStatusOps>> extends Effect.Effect<infer A, any, any> ? A : never;
