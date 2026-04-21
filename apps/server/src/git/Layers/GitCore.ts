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

  return {
    execute,
    status: statusOps.status,
    statusDetails: statusOps.statusDetails,
    statusDetailsLocal: statusOps.statusDetailsLocal,
    prepareCommitContext: statusOps.prepareCommitContext,
    commit: statusOps.commit,
    pushCurrentBranch: statusOps.pushCurrentBranch,
    pullCurrentBranch: statusOps.pullCurrentBranch,
    readRangeContext: statusOps.readRangeContext,
    readConfigValue: statusOps.readConfigValue,
    listBranches: branchOps.listBranches,
    checkoutBranch: branchOps.checkoutBranch,
    createBranch: branchOps.createBranch,
    renameBranch: branchOps.renameBranch,
    setBranchUpstream: branchOps.setBranchUpstream,
    listLocalBranchNames: branchOps.listLocalBranchNames,
    initRepo: branchOps.initRepo,
    ensureRemote: branchOps.ensureRemote,
    createWorktree: worktreeOps.createWorktree,
    removeWorktree: worktreeOps.removeWorktree,
    fetchPullRequestBranch: worktreeOps.fetchPullRequestBranch,
    fetchRemoteBranch: worktreeOps.fetchRemoteBranch,
    isInsideWorkTree: worktreeOps.isInsideWorkTree,
    listWorkspaceFiles: worktreeOps.listWorkspaceFiles,
    filterIgnoredPaths: worktreeOps.filterIgnoredPaths,
  } satisfies GitCoreShape;
});

export const GitCoreLive = Layer.effect(GitCore, makeGitCore());
