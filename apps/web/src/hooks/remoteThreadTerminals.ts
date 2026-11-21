import type { ThreadId } from "@bigbud/contracts";

import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../rpc/nativeApi";
import {
  areDisconnectedTargetsLoaded,
  isExecutionTargetDisconnected,
} from "../stores/remoteAccess/remoteAccess.store";
import { useTerminalStateStore } from "../stores/terminal";
import { terminalPaneOpenOptions } from "../stores/terminal/terminal.store.paneOrigin";

export interface RemoteThreadTerminalTarget {
  readonly threadId: ThreadId;
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly worktreePath?: string;
}

/** Re-opens the thread's open terminals on the remote target once access is back. */
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
  await Promise.all(
    terminalState.terminalIds.map((terminalId) =>
      api.terminal.open({
        // Restored panes only reattach (`attachOnly`); they are never respawned.
        ...terminalPaneOpenOptions(target.threadId, terminalId),
        threadId: target.threadId,
        executionTargetId: target.executionTargetId,
        terminalId,
        cwd: target.cwd!,
        ...(target.worktreePath ? { worktreePath: target.worktreePath } : {}),
      }),
    ),
  );
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
