import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import type { ServerConnectRemoteAgentResult } from "@bigbud/contracts/server/server.ts";

import { connectExecutionTargetForSetup } from "../../stores/remoteAccess/remoteAccess.connect";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import {
  completeRemoteAgentAdmission,
  getRemoteAgentAdmissionRequestId,
} from "../../stores/remoteAccess/remoteAgentAdmissionRequest";
import {
  notifyRemoteAgentConnection,
  remoteAgentConnectionWarning,
} from "./SidebarRemoteAgentConnection.notifications";

type RemoteAgentInstallApi = {
  readonly server: Pick<
    NativeApi["server"],
    "installRemoteAgent" | "connectRemoteAgent" | "connectExecutionTarget"
  >;
};

export type RemoteAgentInstallProgress = "downloading" | "connecting";

export interface RemoteAgentInstallAndConnectResult {
  readonly connected: ServerConnectRemoteAgentResult;
  /** Connected version, or the fallback warning when the new build could not be used. */
  readonly message: string;
  /** Older builds removed, or still in use by live work. */
  readonly cleanupMessage: string | null;
  readonly warning: boolean;
}

/**
 * Fresh admission with retirement of older builds (D7). The logical request ID survives retries
 * of an unresolved connect, and only a confirmed connect records the runtime and notifies.
 */
export async function connectFreshRemoteAgent(
  api: Pick<RemoteAgentInstallApi, "server">,
  executionTargetId: string,
): Promise<ServerConnectRemoteAgentResult> {
  const requestId = getRemoteAgentAdmissionRequestId(executionTargetId);
  const connected = await api.server.connectRemoteAgent({
    executionTargetId,
    requestId,
    intent: "fresh",
    replace: true,
  });
  useRemoteAccessStore.getState().recordRemoteConnection(executionTargetId, connected);
  notifyRemoteAgentConnection(executionTargetId, connected);
  completeRemoteAgentAdmission(executionTargetId, requestId);
  return connected;
}

/**
 * The one install-then-connect sequence shared by the workspace dialog's Save and Settings →
 * Install agent: the existing install pipeline with `replace: true`, then a fresh connect. No
 * confirmation dialog; callers show progress and the cleanup outcome inline.
 */
export async function installAndConnectRemoteAgent(input: {
  readonly api: RemoteAgentInstallApi;
  readonly executionTargetId: string;
  readonly onProgress?: (progress: RemoteAgentInstallProgress) => void;
}): Promise<RemoteAgentInstallAndConnectResult> {
  const { api, executionTargetId } = input;
  await connectExecutionTargetForSetup(api, executionTargetId);
  input.onProgress?.("downloading");
  const installed = await api.server.installRemoteAgent({ executionTargetId, replace: true });
  if (installed.outcome === "failed" || installed.outcome === "uncertain") {
    throw new Error(installed.message);
  }
  input.onProgress?.("connecting");
  const connected = await connectFreshRemoteAgent(api, executionTargetId);
  const warning = remoteAgentConnectionWarning(connected);
  return {
    connected,
    message: warning ?? `Connected to remote agent ${connected.currentVersion}.`,
    cleanupMessage: connected.cleanupMessage ?? null,
    warning: warning !== undefined,
  };
}

type RemoteAgentVerification = NonNullable<
  Awaited<ReturnType<NativeApi["server"]["verifyExecutionTarget"]>>["remoteAgent"]
>;

/**
 * Save installs or replaces the agent when verification says it is missing or outdated, or when
 * a downloaded update waits for the next connect. The identical verified build is skipped.
 */
export async function remoteAgentNeedsInstallOnSave(input: {
  readonly api: { readonly server: Pick<NativeApi["server"], "getRemoteAgentUpdateStatus"> };
  readonly executionTargetId: string;
  readonly verification: RemoteAgentVerification | undefined;
}): Promise<boolean> {
  const status = input.verification?.status;
  if (status === "install-required" || status === "upgrade-required") return true;
  if (status !== "ready") return false;
  try {
    const update = await input.api.server.getRemoteAgentUpdateStatus({
      executionTargetId: input.executionTargetId,
    });
    if (update.phase !== "ready-for-next-reconnect" || update.pendingVersion === null) return false;
    // The identical verified build is already active: nothing to install or replace.
    return !(
      update.pendingVersion === update.currentVersion &&
      update.pendingBuildDigestShort !== undefined &&
      update.pendingBuildDigestShort === update.currentBuildDigestShort &&
      update.pendingTargetTriple === update.currentTargetTriple
    );
  } catch {
    return false; // Status is advisory; the active, verified build keeps working.
  }
}
