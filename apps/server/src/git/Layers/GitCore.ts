import { Effect, FileSystem, Layer, Path } from "effect";

import {
  GitCore,
  type GitCoreShape,
  type ExecuteGitInput,
  type ExecuteGitResult,
} from "../Services/GitCore.ts";
import { GitCommandError } from "@bigbud/contracts";
import { ServerConfig } from "../../startup/config.ts";
import { makeRawExecute, wrapExecuteWithMetrics, makeGitHelpers } from "./GitCoreExecutor.ts";
import { makeGitStatusOps } from "./GitStatus.ts";
import { makeGitBranchOps } from "./GitBranches.ts";
import { makeGitWorktreeOps } from "./GitWorktree.ts";
import {
  formatRemoteExecutionTargetDetail,
  isLocalExecutionTarget,
} from "../../executionTargets.ts";

export { makeGitCore };

const makeGitCore = Effect.fn("makeGitCore")(function* (options?: {
  executeOverride?: GitCoreShape["execute"];
}) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const { worktreesDir } = yield* ServerConfig;

  let executeRaw: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;

  if (options?.executeOverride) {
    executeRaw = options.executeOverride;
  } else {
    executeRaw = yield* makeRawExecute();
  }

  const execute: GitCoreShape["execute"] = wrapExecuteWithMetrics(executeRaw);
  const helpers = makeGitHelpers(execute);

  const statusOps = yield* makeGitStatusOps(helpers, path);

  const branchOps = makeGitBranchOps(helpers, statusOps, fileSystem);

  const worktreeOps = makeGitWorktreeOps(helpers, statusOps, path, worktreesDir);

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
              surface: "Git execution",
            }),
          }),
        );

  return {
    execute,
    status: (input) =>
      assertLocalExecutionTarget("git.status", input.cwd, input.executionTargetId).pipe(
        Effect.andThen(statusOps.status(input)),
      ),
    statusDetails: statusOps.statusDetails,
    statusDetailsLocal: statusOps.statusDetailsLocal,
    prepareCommitContext: statusOps.prepareCommitContext,
    commit: statusOps.commit,
    pushCurrentBranch: statusOps.pushCurrentBranch,
    pullCurrentBranch: statusOps.pullCurrentBranch,
    readRangeContext: statusOps.readRangeContext,
    readConfigValue: statusOps.readConfigValue,
    listBranches: (input) =>
      assertLocalExecutionTarget("git.listBranches", input.cwd, input.executionTargetId).pipe(
        Effect.andThen(branchOps.listBranches(input)),
      ),
    checkoutBranch: (input) =>
      assertLocalExecutionTarget("git.checkout", input.cwd, input.executionTargetId).pipe(
        Effect.andThen(branchOps.checkoutBranch(input)),
      ),
    createBranch: (input) =>
      assertLocalExecutionTarget("git.createBranch", input.cwd, input.executionTargetId).pipe(
        Effect.andThen(branchOps.createBranch(input)),
      ),
    renameBranch: branchOps.renameBranch,
    setBranchUpstream: branchOps.setBranchUpstream,
    listLocalBranchNames: branchOps.listLocalBranchNames,
    initRepo: (input) =>
      assertLocalExecutionTarget("git.init", input.cwd, input.executionTargetId).pipe(
        Effect.andThen(branchOps.initRepo(input)),
      ),
    ensureRemote: branchOps.ensureRemote,
    createWorktree: (input) =>
      assertLocalExecutionTarget("git.createWorktree", input.cwd, input.executionTargetId).pipe(
        Effect.andThen(worktreeOps.createWorktree(input)),
      ),
    removeWorktree: (input) =>
      assertLocalExecutionTarget("git.removeWorktree", input.cwd, input.executionTargetId).pipe(
        Effect.andThen(worktreeOps.removeWorktree(input)),
      ),
    fetchPullRequestBranch: worktreeOps.fetchPullRequestBranch,
    fetchRemoteBranch: worktreeOps.fetchRemoteBranch,
    isInsideWorkTree: worktreeOps.isInsideWorkTree,
    listWorkspaceFiles: worktreeOps.listWorkspaceFiles,
    filterIgnoredPaths: worktreeOps.filterIgnoredPaths,
  } satisfies GitCoreShape;
});

export const GitCoreLive = Layer.effect(GitCore, makeGitCore());
