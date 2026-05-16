import { realpathSync } from "node:fs";

import {
  Cache,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Ref,
} from "effect";
import {
  GitCommandError,
  GitActionProgressPhase,
  GitRunStackedActionResult,
  type GitStatusLocalResult,
  type GitStatusRemoteResult,
} from "@bigbud/contracts";

import { GitManager, type GitManagerShape } from "../Services/GitManager.ts";
import { GitCore, GitStatusDetails } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import type { GitManagerServiceError } from "@bigbud/contracts";

import { isCommitAction } from "./GitManager.types.ts";
import {
  gitManagerError,
  normalizePullRequestReference,
  resolvePullRequestWorktreeLocalBranchName,
  toResolvedPullRequest,
  toPullRequestHeadRemoteInfo,
  toStatusPr,
} from "./GitManager.prUtils.ts";

import { createProgressEmitter } from "./GitManager.progress.ts";
import { makePrHelpers } from "./GitManager.prHelpers.ts";
import { makeBranchContext } from "./GitManager.branchContext.ts";
import { makePrLookup } from "./GitManager.prLookup.ts";
import { makeCommitStep } from "./GitManager.commitStep.ts";
import { makePrStep } from "./GitManager.prStep.ts";
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

  const { configurePullRequestHeadUpstream, materializePullRequestHeadBranch } = prHelpers;
  const { findLatestPr, buildCompletionToast } = prLookup;
  const { runCommitStep, runFeatureBranchStep } = commitStep;
  const { runPrStep } = prStep;

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

  const preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = Effect.fn(
    "preparePullRequestThread",
  )(function* (input) {
    yield* assertLocalExecutionTarget(
      "git.preparePullRequestThread",
      input.cwd,
      input.executionTargetId,
    );
    const maybeRunSetupScript = (worktreePath: string) => {
      if (!input.threadId) {
        return Effect.void;
      }
      return projectSetupScriptRunner
        .runForThread({
          threadId: input.threadId,
          projectCwd: input.cwd,
          worktreePath,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `GitManager.preparePullRequestThread: failed to launch worktree setup script for thread ${input.threadId} in ${worktreePath}: ${error.message}`,
            ).pipe(Effect.asVoid),
          ),
        );
    };
    return yield* Effect.gen(function* () {
      const normalizedReference = normalizePullRequestReference(input.reference);
      const rootWorktreePath = canonicalizeExistingPath(input.cwd);
      const pullRequestSummary = yield* gitHubCli.getPullRequest({
        cwd: input.cwd,
        reference: normalizedReference,
      });
      const pullRequest = toResolvedPullRequest(pullRequestSummary);

      if (input.mode === "local") {
        yield* gitHubCli.checkoutPullRequest({
          cwd: input.cwd,
          reference: normalizedReference,
          force: true,
        });
        const details = yield* gitCore.statusDetails(input.cwd);
        yield* configurePullRequestHeadUpstream(
          input.cwd,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          details.branch ?? pullRequest.headBranch,
        );
        return {
          pullRequest,
          branch: details.branch ?? pullRequest.headBranch,
          worktreePath: null,
        };
      }

      const ensureExistingWorktreeUpstream = Effect.fn("ensureExistingWorktreeUpstream")(function* (
        worktreePath: string,
      ) {
        const details = yield* gitCore.statusDetails(worktreePath);
        yield* configurePullRequestHeadUpstream(
          worktreePath,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          details.branch ?? pullRequest.headBranch,
        );
      });

      const pullRequestWithRemoteInfo = {
        ...pullRequest,
        ...toPullRequestHeadRemoteInfo(pullRequestSummary),
      } as const;
      const localPullRequestBranch =
        resolvePullRequestWorktreeLocalBranchName(pullRequestWithRemoteInfo);

      const findLocalHeadBranch = (cwd: string) =>
        gitCore.listBranches({ cwd }).pipe(
          Effect.map((result) => {
            const localBranch = result.branches.find(
              (branch) => !branch.isRemote && branch.name === localPullRequestBranch,
            );
            if (localBranch) {
              return localBranch;
            }
            if (localPullRequestBranch === pullRequest.headBranch) {
              return null;
            }
            return (
              result.branches.find(
                (branch) =>
                  !branch.isRemote &&
                  branch.name === pullRequest.headBranch &&
                  branch.worktreePath !== null &&
                  canonicalizeExistingPath(branch.worktreePath) !== rootWorktreePath,
              ) ?? null
            );
          }),
        );

      const existingBranchBeforeFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchBeforeFetchPath = existingBranchBeforeFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchBeforeFetch.worktreePath)
        : null;
      if (
        existingBranchBeforeFetch?.worktreePath &&
        existingBranchBeforeFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchBeforeFetch.worktreePath);
        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchBeforeFetch.worktreePath,
        };
      }
      if (existingBranchBeforeFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      yield* materializePullRequestHeadBranch(
        input.cwd,
        pullRequestWithRemoteInfo,
        localPullRequestBranch,
      );

      const existingBranchAfterFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchAfterFetchPath = existingBranchAfterFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchAfterFetch.worktreePath)
        : null;
      if (
        existingBranchAfterFetch?.worktreePath &&
        existingBranchAfterFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchAfterFetch.worktreePath);
        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchAfterFetch.worktreePath,
        };
      }
      if (existingBranchAfterFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      const worktree = yield* gitCore.createWorktree({
        cwd: input.cwd,
        branch: localPullRequestBranch,
        path: null,
      });
      yield* ensureExistingWorktreeUpstream(worktree.worktree.path);
      yield* maybeRunSetupScript(worktree.worktree.path);

      return {
        pullRequest,
        branch: worktree.worktree.branch,
        worktreePath: worktree.worktree.path,
      };
    }).pipe(Effect.ensuring(invalidateStatusResultCache(input.cwd)));
  });

  const runStackedAction: GitManagerShape["runStackedAction"] = Effect.fn("runStackedAction")(
    function* (input, options) {
      yield* assertLocalExecutionTarget("git.runStackedAction", input.cwd, input.executionTargetId);
      const progress = createProgressEmitter(input, options);
      const currentPhase = yield* Ref.make<Option.Option<GitActionProgressPhase>>(Option.none());

      const runAction = Effect.fn("runStackedAction.runAction")(function* (): Effect.fn.Return<
        GitRunStackedActionResult,
        GitManagerServiceError
      > {
        const initialStatus = yield* gitCore.statusDetails(input.cwd);
        const wantsCommit = isCommitAction(input.action);
        const wantsPush =
          input.action === "push" ||
          input.action === "commit_push" ||
          input.action === "commit_push_pr" ||
          (input.action === "create_pr" &&
            (!initialStatus.hasUpstream || initialStatus.aheadCount > 0));
        const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";

        if (input.featureBranch && !wantsCommit) {
          return yield* gitManagerError(
            "runStackedAction",
            "Feature-branch checkout is only supported for commit actions.",
          );
        }
        if (input.action === "push" && initialStatus.hasWorkingTreeChanges) {
          return yield* gitManagerError(
            "runStackedAction",
            "Commit or stash local changes before pushing.",
          );
        }
        if (input.action === "create_pr" && initialStatus.hasWorkingTreeChanges) {
          return yield* gitManagerError(
            "runStackedAction",
            "Commit local changes before creating a PR.",
          );
        }

        const phases: GitActionProgressPhase[] = [
          ...(input.featureBranch ? (["branch"] as const) : []),
          ...(wantsCommit ? (["commit"] as const) : []),
          ...(wantsPush ? (["push"] as const) : []),
          ...(wantsPr ? (["pr"] as const) : []),
        ];

        yield* progress.emit({
          kind: "action_started",
          phases,
        });

        if (!input.featureBranch && wantsPush && !initialStatus.branch) {
          return yield* gitManagerError("runStackedAction", "Cannot push from detached HEAD.");
        }
        if (!input.featureBranch && wantsPr && !initialStatus.branch) {
          return yield* gitManagerError(
            "runStackedAction",
            "Cannot create a pull request from detached HEAD.",
          );
        }

        let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
        let commitMessageForStep = input.commitMessage;
        let preResolvedCommitSuggestion:
          | import("./GitManager.types.ts").CommitAndBranchSuggestion
          | undefined = undefined;

        const modelSelection = yield* serverSettingsService.getSettings.pipe(
          Effect.map((settings) => settings.textGenerationModelSelection),
          Effect.mapError((cause) =>
            gitManagerError("runStackedAction", "Failed to get server settings.", cause),
          ),
        );

        if (input.featureBranch) {
          yield* Ref.set(currentPhase, Option.some("branch"));
          yield* progress.emit({
            kind: "phase_started",
            phase: "branch",
            label: "Preparing feature branch...",
          });
          const result = yield* runFeatureBranchStep(
            modelSelection,
            input.cwd,
            initialStatus.branch,
            input.commitMessage,
            input.filePaths,
          );
          branchStep = result.branchStep;
          commitMessageForStep = result.resolvedCommitMessage;
          preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
        } else {
          branchStep = { status: "skipped_not_requested" as const };
        }

        const currentBranch = branchStep.name ?? initialStatus.branch;
        const commitAction = isCommitAction(input.action) ? input.action : null;

        const commit = commitAction
          ? yield* Ref.set(currentPhase, Option.some("commit")).pipe(
              Effect.flatMap(() =>
                runCommitStep(
                  modelSelection,
                  input.cwd,
                  commitAction,
                  currentBranch,
                  commitMessageForStep,
                  preResolvedCommitSuggestion,
                  input.filePaths,
                  options?.progressReporter,
                  progress.actionId,
                ),
              ),
            )
          : { status: "skipped_not_requested" as const };

        const push = wantsPush
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "push",
                label: "Pushing...",
              })
              .pipe(
                Effect.tap(() => Ref.set(currentPhase, Option.some("push"))),
                Effect.flatMap(() => gitCore.pushCurrentBranch(input.cwd, currentBranch)),
              )
          : { status: "skipped_not_requested" as const };

        const pr = wantsPr
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "pr",
                label: "Preparing PR...",
              })
              .pipe(
                Effect.tap(() => Ref.set(currentPhase, Option.some("pr"))),
                Effect.flatMap(() =>
                  runPrStep(modelSelection, input.cwd, currentBranch, progress.emit),
                ),
              )
          : { status: "skipped_not_requested" as const };

        const toast = yield* buildCompletionToast(input.cwd, {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
        });

        const result = {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
          toast,
        };
        yield* progress.emit({
          kind: "action_finished",
          result,
        });
        return result;
      });

      return yield* runAction().pipe(
        Effect.ensuring(invalidateStatusResultCache(input.cwd)),
        Effect.tapError((error) =>
          Effect.flatMap(Ref.get(currentPhase), (phase) =>
            progress.emit({
              kind: "action_failed",
              phase: Option.getOrNull(phase),
              message: error.message,
            }),
          ),
        ),
      );
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
