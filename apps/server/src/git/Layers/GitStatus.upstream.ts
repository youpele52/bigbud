/**
 * GitStatus.upstream - Upstream ref resolution and background refresh cache.
 *
 * @module GitStatus.upstream
 */
import { Cache, Duration, Effect, Exit, Path } from "effect";

import { GitCommandError } from "@bigbud/contracts";
import { parseRemoteNames } from "../remoteRefs.ts";
import {
  parseUpstreamRefWithRemoteNames,
  parseUpstreamRefByFirstSeparator,
} from "./GitCoreUtils.ts";
import { StatusRemoteRefreshCacheKey, type GitHelpers } from "./GitCoreExecutor.ts";
import { type RemoteOps } from "./GitStatus.remotes.ts";

const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;

const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;

export const makeUpstreamOps = Effect.fn("makeUpstreamOps")(function* (
  helpers: GitHelpers,
  path: Path.Path,
  remoteOps: RemoteOps,
) {
  const { executeGit, runGitStdout } = helpers;
  const {
    branchExists,
    remoteBranchExists,
    resolveDefaultBranchName,
    resolvePrimaryRemoteName,
    resolveGitCommonDir,
  } = remoteOps;

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
    const upstreamRef = yield* runGitStdout(
      "GitCore.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }

    const remoteNames = yield* runGitStdout("GitCore.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNames),
      Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  const fetchRemoteForStatus = (
    gitCommonDir: string,
    remoteName: string,
  ): Effect.Effect<void, GitCommandError> => {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    return executeGit(
      "GitCore.fetchRemoteForStatus",
      fetchCwd,
      ["--git-dir", gitCommonDir, "fetch", "--quiet", "--no-tags", remoteName],
      {
        allowNonZeroExit: true,
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
    cacheKey: StatusRemoteRefreshCacheKey,
  ) {
    yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName);
    return true as const;
  });

  const statusRemoteRefreshCache = yield* Cache.makeWith({
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    lookup: refreshStatusRemoteCacheEntry,
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN,
  });

  const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
    cwd: string,
  ) {
    const upstream = yield* resolveCurrentUpstream(cwd);
    if (!upstream) return;
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    yield* Cache.get(
      statusRemoteRefreshCache,
      new StatusRemoteRefreshCacheKey({
        gitCommonDir,
        remoteName: upstream.remoteName,
      }),
    );
  });

  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    branch: string,
  ) {
    const configuredBaseBranch = yield* runGitStdout(
      "GitCore.resolveBaseBranchForNoUpstream.config",
      cwd,
      ["config", "--get", `branch.${branch}.gh-merge-base`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const defaultBranch =
      primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
    const candidates = [
      configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
      defaultBranch,
      ...DEFAULT_BASE_BRANCH_CANDIDATES,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const remotePrefix =
        primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
      const normalizedCandidate = candidate.startsWith("origin/")
        ? candidate.slice("origin/".length)
        : remotePrefix && candidate.startsWith(remotePrefix)
          ? candidate.slice(remotePrefix.length)
          : candidate;
      if (normalizedCandidate.length === 0 || normalizedCandidate === branch) {
        continue;
      }

      if (yield* branchExists(cwd, normalizedCandidate)) {
        return normalizedCandidate;
      }

      if (
        primaryRemoteName &&
        (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
      ) {
        return `${primaryRemoteName}/${normalizedCandidate}`;
      }
    }

    return null;
  });

  const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
    cwd: string,
    branch: string,
  ) {
    const baseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch);
    if (!baseBranch) {
      return 0;
    }

    const result = yield* executeGit(
      "GitCore.computeAheadCountAgainstBase",
      cwd,
      ["rev-list", "--count", `${baseBranch}..HEAD`],
      { allowNonZeroExit: true },
    );
    if (result.code !== 0) {
      return 0;
    }

    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  });

  return {
    resolveCurrentUpstream,
    refreshStatusUpstreamIfStale,
    resolveBaseBranchForNoUpstream,
    computeAheadCountAgainstBase,
  };
});

export type UpstreamOps =
  Awaited<ReturnType<typeof makeUpstreamOps>> extends Effect.Effect<infer A, any, any> ? A : never;
