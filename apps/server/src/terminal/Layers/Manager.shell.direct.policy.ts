import * as Effect from "effect/Effect";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { directShellOwnerKey, type DirectShellLaunchOwnerStore } from "./DirectShellLaunch.owner";
import { isLocalExecutionTarget } from "../../executionTargets";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault";
import type { TerminalSessionState } from "./Manager.types";

export const directShellLaunchUnavailable =
  "Exact SSH/WSL shell profiles are unavailable until safe shutdown is supported. Use Terminal actions → Open Automatic terminal for a new pane.";

/** Production gate; existing owners retain their original lifecycle and are never re-enrolled. */
export function assertDirectShellProfileEnabled(): void {
  throw new Error(directShellLaunchUnavailable);
}

export function hasUnconfirmedDirectShell(session: TerminalSessionState): boolean {
  return (
    Boolean(session.shellUnconfirmedLaunch) &&
    !isLocalExecutionTarget(session.executionTargetId) &&
    !isRemoteAgentExecutionTarget(session.executionTargetId)
  );
}

export const assertDirectShellCloseAvailable = Effect.fn(
  "terminal.assertDirectShellCloseAvailable",
)(function* (
  store: DirectShellLaunchOwnerStore | undefined,
  input: { threadId: string; terminalId: string; executionTargetId: string },
  session?: TerminalSessionState,
) {
  const failure = (detail: string, reason?: "directShellUnconfirmed") =>
    new TerminalExecutionTargetError({ ...input, detail, ...(reason ? { reason } : {}) });
  const owner = store
    ? yield* Effect.tryPromise({
        try: () => store.get(directShellOwnerKey(input.threadId, input.terminalId)),
        catch: () => failure("Could not verify direct shell ownership. Nothing was closed."),
      })
    : undefined;
  if (owner || (session && hasUnconfirmedDirectShell(session)))
    return yield* failure(
      "Remote shell termination cannot be verified. You can dismiss this pane; the remote process may still be running. Ownership and worktree protection are retained.",
      "directShellUnconfirmed",
    );
});

/** Check the durable journal before any bulk-close side effect, including local sessions. */
export const assertDirectShellThreadCloseAvailable = Effect.fn(
  "terminal.assertDirectShellThreadCloseAvailable",
)(function* (store: DirectShellLaunchOwnerStore | undefined, threadId: string) {
  if (!store) return;
  const failure = (detail: string) =>
    new TerminalExecutionTargetError({
      threadId,
      terminalId: "unknown",
      executionTargetId: "unknown",
      detail,
    });
  const hasOwnersForThread = store.hasOwnersForThread;
  if (!hasOwnersForThread)
    return yield* failure(
      "Could not verify thread-wide direct shell ownership. Nothing was closed.",
    );
  const retained = yield* Effect.tryPromise({
    try: () => hasOwnersForThread(threadId),
    catch: () =>
      failure("Could not verify thread-wide direct shell ownership. Nothing was closed."),
  });
  if (retained)
    return yield* failure(
      "Unresolved direct shell ownership prevents bulk cleanup. Terminal history and worktree protection were retained; a remote process may still be running.",
    );
});
