import { realpathSync } from "node:fs";

import { Cache, Duration, Effect, Exit, FileSystem, Layer, Path, PlatformError } from "effect";
import {
  GitCommandError,
  type GitStatusLocalResult,
  type GitStatusRemoteResult,
} from "@bigbud/contracts";

import { GitManager, type GitManagerShape } from "../Services/GitManager.ts";
import { GitCore, GitStatusDetails } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import {
  normalizePullRequestReference,
  toResolvedPullRequest,
  toStatusPr,
} from "./GitManager.prUtils.ts";
import { makePrHelpers } from "./GitManager.prHelpers.ts";
import { makeBranchContext } from "./GitManager.branchContext.ts";
import { makePrLookup } from "./GitManager.prLookup.ts";
import { makeCommitStep } from "./GitManager.commitStep.ts";
import { makePrStep } from "./GitManager.prStep.ts";
import { makePreparePullRequestThreadStep } from "./GitManager.preparePullRequestThread.ts";
import { makeRunStackedActionStep } from "./GitManager.runStackedAction.ts";
import {
  formatRemoteExecutionTargetDetail,
  isLocalExecutionTarget,
} from "../../executionTargets.ts";

const LOCAL_STATUS_CACHE_TTL = Duration.seconds(1);
const REMOTE_STATUS_CACHE_TTL = Duration.seconds(5);
const STATUS_RESULT_CACHE_CAPACITY = 2_048;

function isNotGitRepositoryError(error: import("@bigbud/contracts").GitCommandError): boolean {
  return error.message.toLowerCase().includes("not a git repository");
}

function isMissingDirectoryError(error: unknown): error is PlatformError.PlatformError {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "GitCommandError" &&
    "cause" in error
  ) {
    return isMissingDirectoryError(error.cause);
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "PlatformError" &&
    "reason" in error &&
    typeof error.reason === "object" &&
    error.reason !== null &&
    "_tag" in error.reason &&
    error.reason._tag === "NotFound"
  );
}

function emptyLocalStatus(): GitStatusDetails {
  return {
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
  } satisfies GitStatusDetails;
}

function canonicalizeExistingPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

export const makeGitManager = Effect.fn("makeGitManager")(function* () {
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const textGeneration = yield* TextGeneration;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const serverSettingsService = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // ── Sub-module factories ────────────────────────────────────────────────
  const prHelpers = makePrHelpers(gitCore, gitHubCli);
  const branchContext = makeBranchContext(gitCore, gitHubCli);
  const prLookup = makePrLookup(gitCore, gitHubCli, branchContext);
  const commitStep = makeCommitStep(gitCore, textGeneration);
  const prStep = makePrStep(
    gitCore,
    gitHubCli,
    textGeneration,
    fileSystem,
    path,
    branchContext,
    prLookup,
  );
  const { findLatestPr } = prLookup;

  // ── Status caches ────────────────────────────────────────────────────────
  const normalizeStatusCacheKey = (cwd: string) => canonicalizeExistingPath(cwd);

  const readLocalStatus = Effect.fn("readLocalStatus")(function* (cwd: string) {
    const details = yield* gitCore.statusDetailsLocal(cwd).pipe(
      Effect.catchIf(isNotGitRepositoryError, () => Effect.succeed(emptyLocalStatus())),
      Effect.catchIf(isMissingDirectoryError, () => Effect.succeed(emptyLocalStatus())),
    );
    return {
      isRepo: details.isRepo,
      hasOriginRemote: details.hasOriginRemote,
      isDefaultBranch: details.isDefaultBranch,
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
    } satisfies GitStatusLocalResult;
  });

  const readRemoteStatus = Effect.fn("readRemoteStatus")(function* (cwd: string) {
    const details = yield* gitCore.statusDetails(cwd).pipe(
      Effect.catchIf(isNotGitRepositoryError, () => Effect.succeed(emptyLocalStatus())),
      Effect.catchIf(isMissingDirectoryError, () => Effect.succeed(emptyLocalStatus())),
    );

    const pr =
      details.isRepo && details.branch !== null
        ? yield* findLatestPr(cwd, {
            branch: details.branch,
            upstreamRef: details.upstreamRef,
          }).pipe(
            Effect.map((latest) => {
              if (!latest) return null;
              if (details.isDefaultBranch && latest.state !== "open") return null;
              return toStatusPr(latest);
            }),
            Effect.catch(() => Effect.succeed(null)),
          )
        : null;

    return {
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      pr,
    } satisfies GitStatusRemoteResult;
  });

  const readStatus = Effect.fn("readStatus")(function* (cwd: string) {
    const [local, remote] = yield* Effect.all([readLocalStatus(cwd), readRemoteStatus(cwd)], {
      concurrency: "unbounded",
    });
    return {
      isRepo: local.isRepo,
      hasOriginRemote: local.hasOriginRemote,
      isDefaultBranch: local.isDefaultBranch,
      branch: local.branch,
      hasWorkingTreeChanges: local.hasWorkingTreeChanges,
      workingTree: local.workingTree,
      hasUpstream: remote.hasUpstream,
      aheadCount: remote.aheadCount,
      behindCount: remote.behindCount,
      pr: remote.pr,
    };
  });

  const localStatusResultCache = yield* Cache.makeWith({
    capacity: STATUS_RESULT_CACHE_CAPACITY,
    lookup: readLocalStatus,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LOCAL_STATUS_CACHE_TTL : Duration.zero),
  });
  const remoteStatusResultCache = yield* Cache.makeWith({
    capacity: STATUS_RESULT_CACHE_CAPACITY,
    lookup: readRemoteStatus,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? REMOTE_STATUS_CACHE_TTL : Duration.zero),
  });
  const statusResultCache = yield* Cache.makeWith({
    capacity: STATUS_RESULT_CACHE_CAPACITY,
    lookup: readStatus,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LOCAL_STATUS_CACHE_TTL : Duration.zero),
  });

  const invalidateLocalStatus: GitManagerShape["invalidateLocalStatus"] = (cwd) =>
    Cache.invalidate(localStatusResultCache, normalizeStatusCacheKey(cwd));

  const invalidateRemoteStatus: GitManagerShape["invalidateRemoteStatus"] = (cwd) =>
    Cache.invalidate(remoteStatusResultCache, normalizeStatusCacheKey(cwd));

  const invalidateStatus: GitManagerShape["invalidateStatus"] = (cwd) =>
    Effect.all(
      [
        Cache.invalidate(statusResultCache, normalizeStatusCacheKey(cwd)),
        Cache.invalidate(localStatusResultCache, normalizeStatusCacheKey(cwd)),
        Cache.invalidate(remoteStatusResultCache, normalizeStatusCacheKey(cwd)),
      ],
      { concurrency: "unbounded", discard: true },
    );

  // Legacy alias used internally
  const invalidateStatusResultCache = (cwd: string) => invalidateStatus(cwd);

  const assertLocalExecutionTarget = (
    operation: string,
    cwd: string,
    executionTargetId: string | null | undefined,
  ) =>
    isLocalExecutionTarget(executionTargetId)
      ? Effect.void
      : Effect.fail(
          new GitCommandError({
            operation,
            command: "execution-target",
            cwd,
            detail: formatRemoteExecutionTargetDetail({
              executionTargetId,
              surface: "Git workflow",
            }),
          }),
        );

  // ── Public API methods ──────────────────────────────────────────────────
  const status: GitManagerShape["status"] = Effect.fn("status")(function* (input) {
    yield* assertLocalExecutionTarget("git.status", input.cwd, input.executionTargetId);
    return yield* Cache.get(statusResultCache, normalizeStatusCacheKey(input.cwd));
  });

  const localStatus: GitManagerShape["localStatus"] = Effect.fn("localStatus")(function* (input) {
    yield* assertLocalExecutionTarget("git.localStatus", input.cwd, input.executionTargetId);
    return yield* Cache.get(localStatusResultCache, normalizeStatusCacheKey(input.cwd));
  });

  const remoteStatus: GitManagerShape["remoteStatus"] = Effect.fn("remoteStatus")(
    function* (input) {
      yield* assertLocalExecutionTarget("git.remoteStatus", input.cwd, input.executionTargetId);
      return yield* Cache.get(remoteStatusResultCache, normalizeStatusCacheKey(input.cwd));
    },
  );

  const resolvePullRequest: GitManagerShape["resolvePullRequest"] = Effect.fn("resolvePullRequest")(
    function* (input) {
      yield* assertLocalExecutionTarget(
        "git.resolvePullRequest",
        input.cwd,
        input.executionTargetId,
      );
      const pullRequest = yield* gitHubCli
        .getPullRequest({
          cwd: input.cwd,
          reference: normalizePullRequestReference(input.reference),
        })
        .pipe(Effect.map((resolved) => toResolvedPullRequest(resolved)));

      return { pullRequest };
    },
  );
  const { preparePullRequestThread: preparePullRequestThreadStep } =
    makePreparePullRequestThreadStep({
      gitCore,
      gitHubCli,
      projectSetupScriptRunner,
      prHelpers,
      canonicalizeExistingPath,
      invalidateStatus: invalidateStatusResultCache,
    });

  const preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = Effect.fn(
    "preparePullRequestThread",
  )(function* (input) {
    yield* assertLocalExecutionTarget(
      "git.preparePullRequestThread",
      input.cwd,
      input.executionTargetId,
    );
    return yield* preparePullRequestThreadStep(input);
  });

  const { runStackedAction: runStackedActionStep } = makeRunStackedActionStep({
    gitCore,
    serverSettingsService,
    commitStep,
    prLookup,
    prStep,
    invalidateStatus: invalidateStatusResultCache,
  });

  const runStackedAction: GitManagerShape["runStackedAction"] = Effect.fn("runStackedAction")(
    function* (input, options) {
      yield* assertLocalExecutionTarget("git.runStackedAction", input.cwd, input.executionTargetId);
      return yield* runStackedActionStep(input, options);
    },
  );

  return {
    status,
    localStatus,
    remoteStatus,
    invalidateLocalStatus,
    invalidateRemoteStatus,
    invalidateStatus,
    resolvePullRequest,
    preparePullRequestThread,
    runStackedAction,
  } satisfies GitManagerShape;
});

export const GitManagerLive = Layer.effect(GitManager, makeGitManager());
