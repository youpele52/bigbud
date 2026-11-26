import type { ThreadId } from "@bigbud/contracts";

import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../rpc/nativeApi";
import {
  areDisconnectedTargetsLoaded,
  isExecutionTargetDisconnected,
} from "../stores/remoteAccess/remoteAccess.store";
import { useTerminalStateStore } from "../stores/terminal";
import { isTerminalNotRunningError } from "../stores/terminal/terminal.store.ended";

export interface RemoteThreadTerminalTarget {
  readonly threadId: ThreadId;
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly worktreePath?: string;
}

/**
 * Reattaches the thread's open terminals on the remote target once access is back. This runs
 * with no user action, so it is always attach-only (plan D1): it never respawns an ended process
 * or bypasses the limit dialog. A mounted view starts a new process only on a user action.
 */
export async function reconnectRemoteThreadTerminals(target: RemoteThreadTerminalTarget) {
  if (
    !target.cwd ||
    !areDisconnectedTargetsLoaded() ||
    isExecutionTargetDisconnected(target.executionTargetId)
  ) {
    return;
  }
  const api = readNativeApi();
  if (!api) return;
  const terminalState = useTerminalStateStore.getState().terminalStateByThreadId[target.threadId];
  // An open surface always has panes; there is no implicit terminal to reopen.
  if (!terminalState?.terminalOpen) return;
  const results = await Promise.allSettled(
    terminalState.terminalIds.map((terminalId) =>
      api.terminal.open({
        attachOnly: true,
        threadId: target.threadId,
        executionTargetId: target.executionTargetId,
        terminalId,
        cwd: target.cwd!,
        ...(target.worktreePath ? { worktreePath: target.worktreePath } : {}),
      }),
    ),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" && !isTerminalNotRunningError(result.reason),
  );
  if (failure) throw failure.reason;
}

/** Same as `reconnectRemoteThreadTerminals`, reporting a failure as a toast. */
export function reconnectRemoteThreadTerminalsInBackground(target: RemoteThreadTerminalTarget) {
  void reconnectRemoteThreadTerminals(target).catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Failed to refresh remote terminal",
      description: error instanceof Error ? error.message : "An error occurred while reconnecting.",
    });
  });
}
