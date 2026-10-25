import { Effect, Queue, Stream, type Scope } from "effect";
import { randomUUID } from "node:crypto";
import {
  type GitActionProgressEvent,
  type GitManagerServiceError,
  WS_METHODS,
} from "@bigbud/contracts";

import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";
import { isLocalExecutionTarget } from "../executionTargets.ts";
import { listWslDistributions } from "../terminal/Layers/Manager.wsl.process";
import { TerminalWslDiscoveryError } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import {
  connectRemoteAgentEffect,
  getRemoteAgentUpdateStatusEffect,
} from "./wsRemoteAgentAdmission.ts";
import { makeRemoteGitStatusStream } from "../git/remoteGitStatusStream.ts";
import { removePublicWorktree } from "./wsWorktreeRemoval.ts";
import { runOwnedWorktreeOperation } from "./wsWorktreeOwnedOperation.ts";
import {
  installRemoteAgentEffect,
  unlockSshKeyEffect,
  unlockSshPasswordEffect,
  verifyExecutionTargetEffect,
} from "./wsExecutionTargetVerification.ts";
import {
  getRemoteAgentRestartStatusEffect,
  restartRemoteAgentEffect,
} from "./wsRemoteAgentRestart.ts";
import { listSshConfigHostsEffect } from "./wsSshConfigHosts.ts";
import { listRemoteFoldersEffect } from "./wsRemoteFolders.ts";
import { trustSshHostEffect } from "./wsSshHostTrust.ts";

function gitMutationOperationId(operationId: string | undefined, target?: string): string {
  if (!operationId && !isLocalExecutionTarget(target))
    throw new Error(
      "Remote Git requires an originating operation identity. No work was dispatched.",
    );
  return operationId ?? `git-rpc-${randomUUID()}`;
}

function withGitMutationOperationId<
  T extends {
    readonly operationId?: string | undefined;
    readonly executionTargetId?: string | undefined;
  },
>(input: T): T & { readonly operationId: string } {
  return {
    ...input,
    operationId: gitMutationOperationId(input.operationId, input.executionTargetId),
  };
}

export function makeWsRpcGitTerminalHandlers(context: WsRpcContext, worktreeScope?: Scope.Scope) {
  return {
    [WS_METHODS.serverTrustSshHost]: (input: Parameters<typeof trustSshHostEffect>[0]) =>
      observeRpcEffect(WS_METHODS.serverTrustSshHost, trustSshHostEffect(input), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.terminalWslDistributions]: () =>
      observeRpcEffect(
        WS_METHODS.terminalWslDistributions,
        Effect.tryPromise({
          try: (signal) => listWslDistributions(undefined, undefined, { signal }),
          catch: () =>
            new TerminalWslDiscoveryError({
              message: "WSL distribution discovery failed. Check WSL installation and retry.",
            }),
        }),
        { "rpc.aggregate": "terminal" },
      ),
    [WS_METHODS.serverConnectRemoteAgent]: (
      input: Parameters<typeof connectRemoteAgentEffect>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.serverConnectRemoteAgent,
        connectRemoteAgentEffect(input, context.remoteAgentUpdateCoordinator),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverVerifyExecutionTarget]: (
      input: Parameters<typeof verifyExecutionTargetEffect>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.serverVerifyExecutionTarget,
        verifyExecutionTargetEffect(
          input,
          context.remoteAgentHealth,
          context.remoteAgentUpdateCoordinator,
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverListSshConfigHosts]: () =>
      observeRpcEffect(WS_METHODS.serverListSshConfigHosts, listSshConfigHostsEffect(), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverListRemoteFolders]: (input: Parameters<typeof listRemoteFoldersEffect>[0]) =>
      observeRpcEffect(WS_METHODS.serverListRemoteFolders, listRemoteFoldersEffect(input), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverInstallRemoteAgent]: (
      input: Parameters<typeof installRemoteAgentEffect>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.serverInstallRemoteAgent,
        installRemoteAgentEffect(input, context.remoteAgentInstaller),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverUnlockSshKey]: (input: Parameters<typeof unlockSshKeyEffect>[0]) =>
      observeRpcEffect(WS_METHODS.serverUnlockSshKey, unlockSshKeyEffect(input), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverGetRemoteAgentUpdateStatus]: (
      input: Parameters<typeof getRemoteAgentUpdateStatusEffect>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.serverGetRemoteAgentUpdateStatus,
        getRemoteAgentUpdateStatusEffect(input, context.remoteAgentUpdateCoordinator),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverRestartRemoteAgent]: (
      input: Parameters<typeof restartRemoteAgentEffect>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.serverRestartRemoteAgent,
        restartRemoteAgentEffect(input, context.remoteAgentRestart, context.orchestrationEngine),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverGetRemoteAgentRestartStatus]: (
      input: Parameters<typeof getRemoteAgentRestartStatusEffect>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.serverGetRemoteAgentRestartStatus,
        getRemoteAgentRestartStatusEffect(
          input,
          context.remoteAgentRestart,
          context.orchestrationEngine,
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverUnlockSshPassword]: (input: Parameters<typeof unlockSshPasswordEffect>[0]) =>
      observeRpcEffect(WS_METHODS.serverUnlockSshPassword, unlockSshPasswordEffect(input), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.subscribeGitStatus]: (input: {
      readonly cwd: string;
      readonly executionTargetId?: string | undefined;
    }) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeGitStatus,
        isLocalExecutionTarget(input.executionTargetId)
          ? context.gitStatusBroadcaster.subscribe(input.cwd)
          : makeRemoteGitStatusStream({
              git: context.git,
              cwd: input.cwd,
              executionTargetId: input.executionTargetId!,
              invalidation: context.remoteGitStatusInvalidation,
            }),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitRefreshStatus]: (input: Parameters<WsRpcContext["gitManager"]["status"]>[0]) =>
      observeRpcEffect(WS_METHODS.gitRefreshStatus, context.gitStatus(input), {
        "rpc.aggregate": "git",
      }),
    [WS_METHODS.gitListCommits]: (input: Parameters<WsRpcContext["git"]["listCommits"]>[0]) =>
      observeRpcEffect(WS_METHODS.gitListCommits, context.git.listCommits(input), {
        "rpc.aggregate": "git",
      }),
    [WS_METHODS.gitGetCommitDetails]: (
      input: Parameters<WsRpcContext["git"]["getCommitDetails"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.gitGetCommitDetails, context.git.getCommitDetails(input), {
        "rpc.aggregate": "git",
      }),
    [WS_METHODS.gitReadWorkingTreeDiff]: (
      input: Parameters<WsRpcContext["git"]["readWorkingTreeDiff"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.gitReadWorkingTreeDiff, context.git.readWorkingTreeDiff(input), {
        "rpc.aggregate": "git",
      }),
    [WS_METHODS.gitPull]: (input: {
      readonly cwd: string;
      readonly executionTargetId?: string | undefined;
      readonly operationId?: string | undefined;
    }) =>
      observeRpcEffect(
        WS_METHODS.gitPull,
        context.git
          .pullCurrentBranch(
            input.cwd,
            input.executionTargetId,
            gitMutationOperationId(input.operationId, input.executionTargetId),
          )
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitFetch]: (input: {
      readonly cwd: string;
      readonly executionTargetId?: string | undefined;
      readonly operationId?: string | undefined;
    }) =>
      observeRpcEffect(
        WS_METHODS.gitFetch,
        context.git
          .fetch(
            input.cwd,
            input.executionTargetId,
            gitMutationOperationId(input.operationId, input.executionTargetId),
          )
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitDiscardChanges]: (input: {
      readonly cwd: string;
      readonly executionTargetId?: string | undefined;
      readonly operationId?: string | undefined;
    }) =>
      observeRpcEffect(
        WS_METHODS.gitDiscardChanges,
        context.git
          .discardChanges(
            input.cwd,
            input.executionTargetId,
            gitMutationOperationId(input.operationId, input.executionTargetId),
          )
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitRunStackedAction]: (
      input: Parameters<WsRpcContext["gitManager"]["runStackedAction"]>[0] & {
        readonly actionId: string;
      },
    ) =>
      observeRpcStream(
        WS_METHODS.gitRunStackedAction,
        Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
          runThreadAwareGitAction(context, input, {
            actionId: input.actionId,
            progressReporter: {
              publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
            },
          }).pipe(
            Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId)),
            Effect.matchCauseEffect({
              onFailure: (cause) => Queue.failCause(queue, cause),
              onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
            }),
          ),
        ),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitResolvePullRequest]: (
      input: Parameters<WsRpcContext["gitManager"]["resolvePullRequest"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.gitResolvePullRequest,
        context.gitManager.resolvePullRequest(input),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitPreparePullRequestThread]: (
      input: Parameters<WsRpcContext["gitManager"]["preparePullRequestThread"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.gitPreparePullRequestThread,
        context.gitManager
          .preparePullRequestThread(input)
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitListBranches]: (input: Parameters<WsRpcContext["git"]["listBranches"]>[0]) =>
      observeRpcEffect(WS_METHODS.gitListBranches, context.git.listBranches(input), {
        "rpc.aggregate": "git",
      }),
    [WS_METHODS.gitCreateWorktree]: (input: Parameters<WsRpcContext["git"]["createWorktree"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitCreateWorktree,
        context.git
          .createWorktree(withGitMutationOperationId(input))
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitRemoveWorktree]: (input: Parameters<WsRpcContext["git"]["removeWorktree"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitRemoveWorktree,
        runOwnedWorktreeOperation(
          worktreeScope,
          removePublicWorktree(context, withGitMutationOperationId(input)),
        ).pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitCreateBranch]: (input: Parameters<WsRpcContext["git"]["createBranch"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitCreateBranch,
        context.git
          .createBranch(withGitMutationOperationId(input))
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitCheckout]: (input: Parameters<WsRpcContext["git"]["checkoutBranch"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitCheckout,
        context.git
          .checkoutBranch(withGitMutationOperationId(input))
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitRenameBranch]: (input: Parameters<WsRpcContext["git"]["renameBranch"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitRenameBranch,
        context.git
          .renameBranch(withGitMutationOperationId(input))
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitDeleteBranch]: (input: Parameters<WsRpcContext["git"]["deleteBranch"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitDeleteBranch,
        context.git
          .deleteBranch(withGitMutationOperationId(input))
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitInit]: (input: Parameters<WsRpcContext["git"]["initRepo"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitInit,
        context.git
          .initRepo(withGitMutationOperationId(input))
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd, input.executionTargetId))),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.terminalOpen]: (input: Parameters<WsRpcContext["terminalManager"]["open"]>[0]) =>
      observeRpcEffect(WS_METHODS.terminalOpen, context.terminalManager.open(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalSnapshot]: (
      input: Parameters<WsRpcContext["terminalManager"]["snapshot"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.terminalSnapshot, context.terminalManager.snapshot(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalWrite]: (input: Parameters<WsRpcContext["terminalManager"]["write"]>[0]) =>
      observeRpcEffect(WS_METHODS.terminalWrite, context.terminalManager.write(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalResize]: (
      input: Parameters<WsRpcContext["terminalManager"]["resize"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.terminalResize, context.terminalManager.resize(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalClear]: (input: Parameters<WsRpcContext["terminalManager"]["clear"]>[0]) =>
      observeRpcEffect(WS_METHODS.terminalClear, context.terminalManager.clear(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalRestart]: (
      input: Parameters<WsRpcContext["terminalManager"]["restart"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.terminalRestart, context.terminalManager.restart(input), {
        "rpc.aggregate": "terminal",
      }),
    [WS_METHODS.terminalClose]: (input: Parameters<WsRpcContext["terminalManager"]["close"]>[0]) =>
      observeRpcEffect(WS_METHODS.terminalClose, context.terminalManager.close(input), {
        "rpc.aggregate": "terminal",
      }),
  };
}
import { runThreadAwareGitAction } from "./wsGitTextGenerationContext.ts";
