import { Effect, FileSystem, Layer, Option, Path } from "effect";

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
import { makeGitHistoryOps } from "./GitHistory.ts";
import {
  formatRemoteExecutionTargetDetail,
  isLocalExecutionTarget,
} from "../../executionTargets.ts";
import { RemoteAgentGitExecutorService } from "../../remote-agent/remoteAgentGit.ts";
import { requireRemoteGitAgent } from "./GitCore.target.ts";

export { makeGitCore };

const makeGitCore = Effect.fn("makeGitCore")(function* (options?: {
  executeOverride?: GitCoreShape["execute"];
  remoteExecuteOverride?: GitCoreShape["execute"];
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
  const historyOps = makeGitHistoryOps(helpers);

  const remoteAgentGitExecutor = yield* Effect.serviceOption(RemoteAgentGitExecutorService);
  const remoteExecute = options?.remoteExecuteOverride
    ? wrapExecuteWithMetrics(options.remoteExecuteOverride)
    : Option.isSome(remoteAgentGitExecutor)
      ? wrapExecuteWithMetrics(remoteAgentGitExecutor.value)
      : undefined;

  const makeRemoteOpsForTarget = (executionTargetId: string) =>
    Effect.gen(function* () {
      const executeForTarget: GitCoreShape["execute"] = (input) =>
        remoteExecute!({
          ...input,
          executionTargetId: input.executionTargetId ?? executionTargetId,
        });
      const targetHelpers = makeGitHelpers(executeForTarget);
      const targetStatusOps = yield* makeGitStatusOps(targetHelpers, path);
      const targetWorktreeOps = makeGitWorktreeOps(
        targetHelpers,
        targetStatusOps,
        path,
        worktreesDir,
      );
      return {
        statusOps: targetStatusOps,
        branchOps: makeGitBranchOps(targetHelpers, targetStatusOps, fileSystem),
        worktreeOps: targetWorktreeOps,
        historyOps: makeGitHistoryOps(targetHelpers),
      };
    });

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
    execute: (input) => {
      if (!isLocalExecutionTarget(input.executionTargetId)) {
        return remoteExecute
          ? remoteExecute(input)
          : Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "execution-target",
                cwd: input.cwd,
                detail: formatRemoteExecutionTargetDetail({
                  executionTargetId: input.executionTargetId,
                  surface: "Git execution",
                }),
              }),
            );
      }
      return execute(input);
    },
    status: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ statusOps: targetStatusOps }) => targetStatusOps.status(input)),
          )
        : assertLocalExecutionTarget("git.status", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(statusOps.status(input)),
          ),
    statusDetails: (cwd, executionTargetId?: string) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) =>
                targetStatusOps.statusDetails(cwd),
              ),
            )
          : requireRemoteGitAgent("git.statusDetails", cwd, executionTargetId)
        : statusOps.statusDetails(cwd),
    statusDetailsLocal: (cwd, executionTargetId?: string) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) =>
                targetStatusOps.statusDetailsLocal(cwd),
              ),
            )
          : requireRemoteGitAgent("git.statusDetailsLocal", cwd, executionTargetId)
        : statusOps.statusDetailsLocal(cwd),
    prepareCommitContext: (cwd, filePaths, executionTargetId) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) =>
                targetStatusOps.prepareCommitContext(cwd, filePaths),
              ),
            )
          : requireRemoteGitAgent("git.prepareCommitContext", cwd, executionTargetId)
        : statusOps.prepareCommitContext(cwd, filePaths),
    commit: (cwd, subject, body, options) =>
      options?.executionTargetId && !isLocalExecutionTarget(options.executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(options.executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) =>
                targetStatusOps.commit(cwd, subject, body, options),
              ),
            )
          : requireRemoteGitAgent("git.commit", cwd, options.executionTargetId)
        : statusOps.commit(cwd, subject, body, options),
    pushCurrentBranch: (cwd, fallbackBranch, executionTargetId) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) =>
                targetStatusOps.pushCurrentBranch(cwd, fallbackBranch),
              ),
            )
          : requireRemoteGitAgent("git.push", cwd, executionTargetId)
        : statusOps.pushCurrentBranch(cwd, fallbackBranch),
    pullCurrentBranch: (cwd, executionTargetId) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) =>
                targetStatusOps.pullCurrentBranch(cwd),
              ),
            )
          : requireRemoteGitAgent("git.pull", cwd, executionTargetId)
        : statusOps.pullCurrentBranch(cwd),
    fetch: (cwd, executionTargetId) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) => targetStatusOps.fetch(cwd)),
            )
          : requireRemoteGitAgent("git.fetch", cwd, executionTargetId)
        : statusOps.fetch(cwd),
    discardChanges: (cwd, executionTargetId) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) =>
                targetStatusOps.discardChanges(cwd),
              ),
            )
          : requireRemoteGitAgent("git.discardChanges", cwd, executionTargetId)
        : statusOps.discardChanges(cwd),
    readRangeContext: (cwd, baseBranch, executionTargetId) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) =>
                targetStatusOps.readRangeContext(cwd, baseBranch),
              ),
            )
          : requireRemoteGitAgent("git.readRangeContext", cwd, executionTargetId)
        : statusOps.readRangeContext(cwd, baseBranch),
    readConfigValue: (cwd, key, executionTargetId) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ statusOps: targetStatusOps }) =>
                targetStatusOps.readConfigValue(cwd, key),
              ),
            )
          : requireRemoteGitAgent("git.readConfigValue", cwd, executionTargetId)
        : statusOps.readConfigValue(cwd, key),
    listBranches: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ branchOps: targetBranchOps }) => targetBranchOps.listBranches(input)),
          )
        : assertLocalExecutionTarget("git.listBranches", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(branchOps.listBranches(input)),
          ),
    listCommits: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ historyOps: targetHistoryOps }) =>
              targetHistoryOps.listCommits(input),
            ),
          )
        : assertLocalExecutionTarget("git.listCommits", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(historyOps.listCommits(input)),
          ),
    getCommitDetails: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ historyOps: targetHistoryOps }) =>
              targetHistoryOps.getCommitDetails(input),
            ),
          )
        : assertLocalExecutionTarget(
            "git.getCommitDetails",
            input.cwd,
            input.executionTargetId,
          ).pipe(Effect.andThen(historyOps.getCommitDetails(input))),
    readWorkingTreeDiff: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ historyOps: targetHistoryOps }) =>
              targetHistoryOps.readWorkingTreeDiff(input),
            ),
          )
        : assertLocalExecutionTarget(
            "git.readWorkingTreeDiff",
            input.cwd,
            input.executionTargetId,
          ).pipe(Effect.andThen(historyOps.readWorkingTreeDiff(input))),
    checkoutBranch: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ branchOps: targetBranchOps }) =>
              targetBranchOps.checkoutBranch(input),
            ),
          )
        : assertLocalExecutionTarget("git.checkout", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(branchOps.checkoutBranch(input)),
          ),
    createBranch: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ branchOps: targetBranchOps }) => targetBranchOps.createBranch(input)),
          )
        : assertLocalExecutionTarget("git.createBranch", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(branchOps.createBranch(input)),
          ),
    renameBranch: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ branchOps: targetBranchOps }) => targetBranchOps.renameBranch(input)),
          )
        : assertLocalExecutionTarget("git.renameBranch", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(branchOps.renameBranch(input)),
          ),
    deleteBranch: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ branchOps: targetBranchOps }) => targetBranchOps.deleteBranch(input)),
          )
        : assertLocalExecutionTarget("git.deleteBranch", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(branchOps.deleteBranch(input)),
          ),
    setBranchUpstream: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ branchOps: targetBranchOps }) =>
              targetBranchOps.setBranchUpstream(input),
            ),
          )
        : assertLocalExecutionTarget(
            "git.setBranchUpstream",
            input.cwd,
            input.executionTargetId,
          ).pipe(Effect.andThen(branchOps.setBranchUpstream(input))),
    listLocalBranchNames: (cwd, executionTargetId) =>
      executionTargetId && !isLocalExecutionTarget(executionTargetId)
        ? remoteExecute
          ? makeRemoteOpsForTarget(executionTargetId).pipe(
              Effect.flatMap(({ branchOps: targetBranchOps }) =>
                targetBranchOps.listLocalBranchNames(cwd),
              ),
            )
          : requireRemoteGitAgent("git.listLocalBranchNames", cwd, executionTargetId)
        : branchOps.listLocalBranchNames(cwd),
    initRepo: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ branchOps: targetBranchOps }) => targetBranchOps.initRepo(input)),
          )
        : assertLocalExecutionTarget("git.init", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(branchOps.initRepo(input)),
          ),
    ensureRemote: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ branchOps: targetBranchOps }) => targetBranchOps.ensureRemote(input)),
          )
        : assertLocalExecutionTarget("git.ensureRemote", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(branchOps.ensureRemote(input)),
          ),
    createWorktree: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? input.path === null
          ? Effect.fail(
              new GitCommandError({
                operation: "git.createWorktree",
                command: "git worktree add",
                cwd: input.cwd,
                detail: "A remote worktree path is required.",
              }),
            )
          : makeRemoteOpsForTarget(input.executionTargetId!).pipe(
              Effect.flatMap(({ worktreeOps: targetWorktreeOps }) =>
                targetWorktreeOps.createWorktree(input),
              ),
            )
        : assertLocalExecutionTarget("git.createWorktree", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(worktreeOps.createWorktree(input)),
          ),
    removeWorktree: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ worktreeOps: targetWorktreeOps }) =>
              targetWorktreeOps.removeWorktree(input),
            ),
          )
        : assertLocalExecutionTarget("git.removeWorktree", input.cwd, input.executionTargetId).pipe(
            Effect.andThen(worktreeOps.removeWorktree(input)),
          ),
    fetchPullRequestBranch: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ worktreeOps: targetWorktreeOps }) =>
              targetWorktreeOps.fetchPullRequestBranch(input),
            ),
          )
        : assertLocalExecutionTarget(
            "git.fetchPullRequestBranch",
            input.cwd,
            input.executionTargetId,
          ).pipe(Effect.andThen(worktreeOps.fetchPullRequestBranch(input))),
    fetchRemoteBranch: (input) =>
      !isLocalExecutionTarget(input.executionTargetId) && remoteExecute
        ? makeRemoteOpsForTarget(input.executionTargetId!).pipe(
            Effect.flatMap(({ worktreeOps: targetWorktreeOps }) =>
              targetWorktreeOps.fetchRemoteBranch(input),
            ),
          )
        : assertLocalExecutionTarget(
            "git.fetchRemoteBranch",
            input.cwd,
            input.executionTargetId,
          ).pipe(Effect.andThen(worktreeOps.fetchRemoteBranch(input))),
    isInsideWorkTree: worktreeOps.isInsideWorkTree,
    listWorkspaceFiles: worktreeOps.listWorkspaceFiles,
    filterIgnoredPaths: worktreeOps.filterIgnoredPaths,
  } satisfies GitCoreShape;
});

export const GitCoreLive = Layer.effect(GitCore, makeGitCore());
