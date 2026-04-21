/**
 * GitStatus - Status, upstream refresh, commit, push, and pull operations.
 *
 * @module GitStatus
 */
import { Effect, Path } from "effect";

import { type GitCoreShape, type GitStatusDetails } from "../Services/GitCore.ts";
import {
  parseBranchAb,
  parseNumstatEntries,
  parsePorcelainPath,
  createGitCommandError,
  isMissingGitCwdError,
} from "./GitCoreUtils.ts";
import { type GitHelpers } from "./GitCoreExecutor.ts";
import { makeRemoteOps } from "./GitStatus.remotes.ts";
import { makeUpstreamOps } from "./GitStatus.upstream.ts";
import { makeCommitOps } from "./GitStatus.commit.ts";

const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
});

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

  const statusDetails: GitCoreShape["statusDetails"] = Effect.fn("statusDetails")(function* (cwd) {
    yield* refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchIf(isMissingGitCwdError, () => Effect.void),
      Effect.ignoreCause({ log: true }),
    );

    const statusResult = yield* executeGit(
      "GitCore.statusDetails.status",
      cwd,
      ["status", "--porcelain=2", "--branch"],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.code !== 0) {
      const stderr = statusResult.stderr.trim();
      return yield* createGitCommandError(
        "GitCore.statusDetails.status",
        cwd,
        ["status", "--porcelain=2", "--branch"],
        stderr || "git status failed",
      );
    }

    const [unstagedNumstatStdout, stagedNumstatStdout, defaultRefResult, hasOriginRemote] =
      yield* Effect.all(
        [
          runGitStdout("GitCore.statusDetails.unstagedNumstat", cwd, ["diff", "--numstat"]),
          runGitStdout("GitCore.statusDetails.stagedNumstat", cwd, [
            "diff",
            "--cached",
            "--numstat",
          ]),
          executeGit(
            "GitCore.statusDetails.defaultRef",
            cwd,
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            {
              allowNonZeroExit: true,
            },
          ),
          originRemoteExists(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
        ],
        { concurrency: "unbounded" },
      );
    const statusStdout = statusResult.stdout;
    const defaultBranch =
      defaultRefResult.code === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    let branch: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesWithoutNumstat = new Set<string>();

    for (const line of statusStdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        branch = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const value = line.slice("# branch.ab ".length).trim();
        const parsed = parseBranchAb(value);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) {
        hasWorkingTreeChanges = true;
        const pathValue = parsePorcelainPath(line);
        if (pathValue) changedFilesWithoutNumstat.add(pathValue);
      }
    }

    if (!upstreamRef && branch) {
      aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
        Effect.catch(() => Effect.succeed(0)),
      );
      behindCount = 0;
    }

    const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
    const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of [...stagedEntries, ...unstagedEntries]) {
      const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
      existing.insertions += entry.insertions;
      existing.deletions += entry.deletions;
      fileStatMap.set(entry.path, existing);
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries())
      .map(([filePath, stat]) => {
        insertions += stat.insertions;
        deletions += stat.deletions;
        return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const filePath of changedFilesWithoutNumstat) {
      if (fileStatMap.has(filePath)) continue;
      files.push({ path: filePath, insertions: 0, deletions: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      isRepo: true,
      hasOriginRemote,
      isDefaultBranch:
        branch !== null &&
        (branch === defaultBranch ||
          (defaultBranch === null && (branch === "main" || branch === "master"))),
      branch,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files,
        insertions,
        deletions,
      },
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
    } satisfies GitStatusDetails;
  });

  /**
   * Like `statusDetails` but skips the upstream fetch refresh — reads only local state.
   * Used by the broadcaster to publish low-latency local status without triggering
   * a remote fetch on every call.
   */
  const statusDetailsLocal: GitCoreShape["statusDetailsLocal"] = Effect.fn("statusDetailsLocal")(
    function* (cwd) {
      const statusResult = yield* executeGit(
        "GitCore.statusDetailsLocal.status",
        cwd,
        ["status", "--porcelain=2", "--branch"],
        {
          allowNonZeroExit: true,
        },
      ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));

      if (statusResult === null) {
        return NON_REPOSITORY_STATUS_DETAILS;
      }

      if (statusResult.code !== 0) {
        const stderr = statusResult.stderr.trim();
        return yield* createGitCommandError(
          "GitCore.statusDetailsLocal.status",
          cwd,
          ["status", "--porcelain=2", "--branch"],
          stderr || "git status failed",
        );
      }

      const [unstagedNumstatStdout, stagedNumstatStdout, defaultRefResult, hasOriginRemote] =
        yield* Effect.all(
          [
            runGitStdout("GitCore.statusDetailsLocal.unstagedNumstat", cwd, ["diff", "--numstat"]),
            runGitStdout("GitCore.statusDetailsLocal.stagedNumstat", cwd, [
              "diff",
              "--cached",
              "--numstat",
            ]),
            executeGit(
              "GitCore.statusDetailsLocal.defaultRef",
              cwd,
              ["symbolic-ref", "refs/remotes/origin/HEAD"],
              {
                allowNonZeroExit: true,
              },
            ),
            originRemoteExists(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
          ],
          { concurrency: "unbounded" },
        );

      const statusStdout = statusResult.stdout;
      const defaultBranch =
        defaultRefResult.code === 0
          ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
          : null;

      let branch: string | null = null;
      let upstreamRef: string | null = null;
      let aheadCount = 0;
      let behindCount = 0;
      let hasWorkingTreeChanges = false;
      const changedFilesWithoutNumstat = new Set<string>();

      for (const line of statusStdout.split(/\r?\n/g)) {
        if (line.startsWith("# branch.head ")) {
          const value = line.slice("# branch.head ".length).trim();
          branch = value.startsWith("(") ? null : value;
          continue;
        }
        if (line.startsWith("# branch.upstream ")) {
          const value = line.slice("# branch.upstream ".length).trim();
          upstreamRef = value.length > 0 ? value : null;
          continue;
        }
        if (line.startsWith("# branch.ab ")) {
          const value = line.slice("# branch.ab ".length).trim();
          const parsed = parseBranchAb(value);
          aheadCount = parsed.ahead;
          behindCount = parsed.behind;
          continue;
        }
        if (line.trim().length > 0 && !line.startsWith("#")) {
          hasWorkingTreeChanges = true;
          const pathValue = parsePorcelainPath(line);
          if (pathValue) changedFilesWithoutNumstat.add(pathValue);
        }
      }

      if (!upstreamRef && branch) {
        aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(0)),
        );
        behindCount = 0;
      }

      const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
      const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
      const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
      for (const entry of [...stagedEntries, ...unstagedEntries]) {
        const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
        existing.insertions += entry.insertions;
        existing.deletions += entry.deletions;
        fileStatMap.set(entry.path, existing);
      }

      let insertions = 0;
      let deletions = 0;
      const files = Array.from(fileStatMap.entries())
        .map(([filePath, stat]) => {
          insertions += stat.insertions;
          deletions += stat.deletions;
          return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
        })
        .toSorted((a, b) => a.path.localeCompare(b.path));

      for (const filePath of changedFilesWithoutNumstat) {
        if (fileStatMap.has(filePath)) continue;
        files.push({ path: filePath, insertions: 0, deletions: 0 });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      return {
        isRepo: true,
        hasOriginRemote,
        isDefaultBranch:
          branch !== null &&
          (branch === defaultBranch ||
            (defaultBranch === null && (branch === "main" || branch === "master"))),
        branch,
        upstreamRef,
        hasWorkingTreeChanges,
        workingTree: {
          files,
          insertions,
          deletions,
        },
        hasUpstream: upstreamRef !== null,
        aheadCount,
        behindCount,
      } satisfies GitStatusDetails;
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
