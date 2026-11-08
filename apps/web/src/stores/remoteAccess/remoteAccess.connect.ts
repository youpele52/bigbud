import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";

import { isExecutionTargetDisconnected, useRemoteAccessStore } from "./remoteAccess.store";

type ConnectExecutionTargetApi = {
  readonly server: Pick<NativeApi["server"], "connectExecutionTarget">;
};

/** Clears a user-initiated disconnect on the server, then locally. Throws if the server refuses. */
export async function connectExecutionTarget(
  api: ConnectExecutionTargetApi,
  executionTargetId: string,
): Promise<void> {
  await api.server.connectExecutionTarget({ executionTargetId });
  useRemoteAccessStore.getState().clearExecutionTargetDisconnected(executionTargetId);
}

/**
 * Adding or editing a remote workspace is an explicit request to connect, so a disconnect flag
 * left on its target (including one orphaned by removing a workspace) is cleared before verifying.
 * Returns whether a connect was needed; throws if the server refuses.
 */
export async function connectExecutionTargetForSetup(
  api: ConnectExecutionTargetApi,
  executionTargetId: string,
): Promise<boolean> {
  if (!isExecutionTargetDisconnected(executionTargetId)) return false;
  await connectExecutionTarget(api, executionTargetId);
  return true;
}
