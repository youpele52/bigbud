import { getRemoteWorkspaceTargetLabel } from "../components/sidebar/Sidebar.remoteWorkspaces.logic";
import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../rpc/nativeApi";
import { connectExecutionTarget } from "../stores/remoteAccess/remoteAccess.connect";
import {
  isExecutionTargetDisconnected,
  useRemoteAccessStore,
} from "../stores/remoteAccess/remoteAccess.store";

interface RemoteExecutionTargetConnectionInput {
  readonly executionTargetId: string;
  /** Workspace name shown in toasts; defaults to the SSH target label. */
  readonly name?: string;
}

const disconnectedToastIds = new Map<string, ReturnType<typeof toastManager.add>>();

export function remoteExecutionTargetDisplayName(input: RemoteExecutionTargetConnectionInput) {
  return (
    input.name ?? getRemoteWorkspaceTargetLabel(input.executionTargetId) ?? input.executionTargetId
  );
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function closeDisconnectedToast(executionTargetId: string) {
  const toastId = disconnectedToastIds.get(executionTargetId);
  if (toastId === undefined) return;
  toastManager.close(toastId);
  disconnectedToastIds.delete(executionTargetId);
}

/** Persists a user-initiated disconnect, then drops local verification for the target. */
export async function disconnectRemoteExecutionTarget(
  input: RemoteExecutionTargetConnectionInput,
): Promise<boolean> {
  const api = readNativeApi();
  if (!api) return false;
  const name = remoteExecutionTargetDisplayName(input);
  const progressToastId = toastManager.add({
    type: "loading",
    title: `Disconnecting "${name}"`,
    timeout: 0,
    data: { hideCopyButton: true },
  });
  try {
    await api.server.disconnectExecutionTarget({ executionTargetId: input.executionTargetId });
    const store = useRemoteAccessStore.getState();
    store.markExecutionTargetDisconnected(input.executionTargetId);
    store.clearExecutionTargetVerified(input.executionTargetId);
    toastManager.close(progressToastId);
    toastManager.add({
      type: "success",
      title: `Disconnected "${name}"`,
      description: "bigbud will not reconnect to this host until you choose Connect.",
    });
    return true;
  } catch (error) {
    toastManager.close(progressToastId);
    toastManager.add({
      type: "error",
      title: `Failed to disconnect "${name}"`,
      description: describeError(error, "The remote connection could not be closed."),
    });
    return false;
  }
}

/** Clears a user-initiated disconnect and stale verification; callers then run the access check. */
export async function connectRemoteExecutionTarget(
  input: RemoteExecutionTargetConnectionInput,
): Promise<boolean> {
  const api = readNativeApi();
  if (!api) return false;
  closeDisconnectedToast(input.executionTargetId);
  try {
    await connectExecutionTarget(api, input.executionTargetId);
    // A check that raced the earlier Disconnect may have re-marked it; always verify afresh.
    useRemoteAccessStore.getState().clearExecutionTargetVerified(input.executionTargetId);
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Failed to connect "${remoteExecutionTargetDisplayName(input)}"`,
      description: describeError(error, "The remote workspace is still disconnected."),
    });
    return false;
  }
}

/**
 * Blocks access to a user-disconnected target without verifying it. Offers Connect, which
 * clears the flag and then runs `onConnected` (normally the original access check).
 */
export function blockDisconnectedRemoteExecutionTarget(
  input: RemoteExecutionTargetConnectionInput & {
    readonly onConnected: () => Promise<unknown> | void;
  },
): boolean {
  if (!isExecutionTargetDisconnected(input.executionTargetId)) return false;
  closeDisconnectedToast(input.executionTargetId);
  const toastId = toastManager.add({
    type: "warning",
    title: `${remoteExecutionTargetDisplayName(input)} is disconnected`,
    description: "bigbud will not reconnect until you choose Connect.",
    actionProps: {
      children: "Connect",
      onClick: () => {
        void (async () => {
          if (await connectRemoteExecutionTarget(input)) await input.onConnected();
        })();
      },
    },
  });
  disconnectedToastIds.set(input.executionTargetId, toastId);
  return true;
}
