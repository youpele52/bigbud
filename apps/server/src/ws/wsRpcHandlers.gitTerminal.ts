import { Effect, Queue, Stream } from "effect";
import {
  type GitActionProgressEvent,
  type GitManagerServiceError,
  type TerminalEvent,
  WS_METHODS,
} from "@bigbud/contracts";

import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";
import {
  unlockSshKeyEffect,
  unlockSshPasswordEffect,
  verifyExecutionTargetEffect,
} from "./wsExecutionTargetVerification.ts";

export function makeWsRpcGitTerminalHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverVerifyExecutionTarget]: (
      input: Parameters<typeof verifyExecutionTargetEffect>[0],
    ) =>
      observeRpcEffect(WS_METHODS.serverVerifyExecutionTarget, verifyExecutionTargetEffect(input), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverUnlockSshKey]: (input: Parameters<typeof unlockSshKeyEffect>[0]) =>
      observeRpcEffect(WS_METHODS.serverUnlockSshKey, unlockSshKeyEffect(input), {
        "rpc.aggregate": "server",
      }),
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
        context
          .assertLocalGitExecutionTarget(input.cwd, input.executionTargetId, "git.subscribeStatus")
          .pipe(Effect.andThen(context.gitStatusBroadcaster.subscribe(input.cwd))),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitRefreshStatus]: (input: Parameters<WsRpcContext["gitManager"]["status"]>[0]) =>
      observeRpcEffect(WS_METHODS.gitRefreshStatus, context.gitManager.status(input), {
        "rpc.aggregate": "git",
      }),
    [WS_METHODS.gitPull]: (input: {
      readonly cwd: string;
      readonly executionTargetId?: string | undefined;
    }) =>
      observeRpcEffect(
        WS_METHODS.gitPull,
        context.assertLocalGitExecutionTarget(input.cwd, input.executionTargetId, "git.pull").pipe(
          Effect.andThen(context.git.pullCurrentBranch(input.cwd)),
          Effect.tap(() => context.refreshGitStatus(input.cwd)),
        ),
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
          context.gitManager
            .runStackedAction(input, {
              actionId: input.actionId,
              progressReporter: {
                publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
              },
            })
            .pipe(
              Effect.tap(() => context.refreshGitStatus(input.cwd)),
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
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd))),
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
          .createWorktree(input)
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitRemoveWorktree]: (input: Parameters<WsRpcContext["git"]["removeWorktree"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitRemoveWorktree,
        context.git
          .removeWorktree(input)
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitCreateBranch]: (input: Parameters<WsRpcContext["git"]["createBranch"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitCreateBranch,
        context.git.createBranch(input).pipe(Effect.tap(() => context.refreshGitStatus(input.cwd))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitCheckout]: (input: Parameters<WsRpcContext["git"]["checkoutBranch"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitCheckout,
        context.git
          .checkoutBranch(input)
          .pipe(Effect.tap(() => context.refreshGitStatus(input.cwd))),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitInit]: (input: Parameters<WsRpcContext["git"]["initRepo"]>[0]) =>
      observeRpcEffect(
        WS_METHODS.gitInit,
        context.git.initRepo(input).pipe(Effect.tap(() => context.refreshGitStatus(input.cwd))),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.terminalOpen]: (input: Parameters<WsRpcContext["terminalManager"]["open"]>[0]) =>
      observeRpcEffect(WS_METHODS.terminalOpen, context.terminalManager.open(input), {
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
    [WS_METHODS.subscribeTerminalEvents]: (_input: unknown) =>
      observeRpcStream(
        WS_METHODS.subscribeTerminalEvents,
        Stream.callback<TerminalEvent>((queue) =>
          Effect.acquireRelease(
            context.terminalManager.subscribe((event) => Queue.offer(queue, event)),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
        { "rpc.aggregate": "terminal" },
      ),
  };
}
