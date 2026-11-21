import type { ThreadId } from "@bigbud/contracts";

import { toastManager } from "../components/ui/toast";
import { DEFAULT_THREAD_TERMINAL_ID } from "../models/types";
import { readNativeApi } from "../rpc/nativeApi";
import {
  areDisconnectedTargetsLoaded,
  isExecutionTargetDisconnected,
} from "../stores/remoteAccess/remoteAccess.store";
import { useTerminalStateStore } from "../stores/terminal";

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
  if (!terminalState?.terminalOpen) return;
  const terminalIds =
    terminalState.terminalIds.length > 0 ? terminalState.terminalIds : [DEFAULT_THREAD_TERMINAL_ID];
  await Promise.all(
    terminalIds.map((terminalId) =>
      api.terminal.open({
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
