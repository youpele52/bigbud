import { useEffect, useRef, useState } from "react";
import type {
  ServerRemoteAgentRuntimeSummary,
  ServerRemoteAgentUpdateStatus,
} from "@bigbud/contracts/server/server.ts";
import { readNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { REMOTE_AGENT_FAILURE_GUIDANCE } from "./SidebarRemoteAgentStatus.messages";
import {
  describeAgentBuild,
  downloadedUpdateVersion,
  REMOTE_AGENT_STATUS_FOOTER,
  REMOTE_AGENT_STATUS_LABELS as LABELS,
  remoteAgentUpdateStatusMessage,
  remoteAgentUpdateStatusTone,
} from "./SidebarRemoteAgentStatus.copy";
import {
  notifyRemoteAgentConnection,
  remoteAgentConnectionWarning,
} from "./SidebarRemoteAgentConnection.notifications";
import {
  REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE,
  useDisconnectedTargetsLoaded,
  useIsExecutionTargetDisconnected,
  useRemoteAccessStore,
} from "../../stores/remoteAccess/remoteAccess.store";
import {
  completeRemoteAgentAdmission,
  getRemoteAgentAdmissionRequestId,
  readRemoteAgentAdmissionRequestId,
} from "../../stores/remoteAccess/remoteAgentAdmissionRequest";
import {
  createRemoteWorkspaceExecutionTargetId,
  type RemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";

export function remoteWorkspaceAgentTarget(draft: RemoteWorkspaceDraft): string | null {
  if (draft.remoteTransport !== "agent") return null;
  try {
    return draft.host.trim() ? createRemoteWorkspaceExecutionTargetId(draft) : null;
  } catch {
    return null;
  }
}

/** Verification/reload only observes; only the explicit fresh button activates pending bytes. */
export function SidebarRemoteAgentStatus({
  executionTargetId,
  cwd,
}: {
  executionTargetId: string;
  cwd: string;
}) {
  const [summary, setSummary] = useState<ServerRemoteAgentRuntimeSummary | null>(null);
  const [updateStatus, setUpdateStatus] = useState<ServerRemoteAgentUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const requestId = useRef<string | undefined>(undefined);
  const revision = useRef(0);
  const disconnected = useIsExecutionTargetDisconnected(executionTargetId);
  const disconnectListLoaded = useDisconnectedTargetsLoaded();
  useEffect(() => {
    let active = true;
    const observedRevision = ++revision.current;
    requestId.current = readRemoteAgentAdmissionRequestId(executionTargetId);
    setSummary(useRemoteAccessStore.getState().remoteConnections[executionTargetId] ?? null);
    setUpdateStatus(null);
    setError(null);
    setBusy(false);
    setMessage(null);
    setFallback(false);
    const api = readNativeApi();
    if (typeof api?.server.getRemoteAgentUpdateStatus === "function")
      void Promise.resolve(
        api.server.getRemoteAgentUpdateStatus({
          executionTargetId,
          ...(requestId.current ? { reconnectRequestId: requestId.current } : {}),
        }),
      )
        .then((status) => {
          if (status && active && observedRevision === revision.current) setUpdateStatus(status);
        })
        .catch(() => undefined);
    // A user-disconnected target is never verified on mount; Connect clears the flag first.
    // Verification also waits until the server's disconnect list has loaded.
    if (disconnected || !disconnectListLoaded)
      return () => {
        active = false;
      };
    void Promise.resolve(api?.server.verifyExecutionTarget({ executionTargetId, cwd }))
      .then((result) => {
        if (!result || !active || observedRevision !== revision.current) return;
        if (result.remoteAgent?.status === "ready")
          useRemoteAccessStore.getState().recordRemoteConnection(
            executionTargetId,
            result.remoteAgent.runtimeSummary ?? {
              currentVersion: result.remoteAgent.version,
              pendingVersion: null,
              fallbackVersion: null,
            },
          );
        if (result.remoteAgent?.status === "ready")
          setSummary(
            result.remoteAgent.runtimeSummary ?? {
              currentVersion: result.remoteAgent.version,
              pendingVersion: null,
              fallbackVersion: null,
            },
          );
      })
      .catch((cause) => {
        if (active && observedRevision === revision.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Remote agent status is unavailable. Verify the SSH connection to retry.",
          );
      });
    return () => {
      active = false;
    };
  }, [executionTargetId, cwd, disconnected, disconnectListLoaded]);

  const perform = async () => {
    if (busy) return;
    const api = readNativeApi();
    if (!api) return;
    const actionRevision = ++revision.current;
    setBusy(true);
    setError(null);
    setMessage(null);
    setFallback(false);
    try {
      const admissionRequestId =
        requestId.current ?? getRemoteAgentAdmissionRequestId(executionTargetId);
      requestId.current = admissionRequestId;
      if (typeof api.server.getRemoteAgentUpdateStatus === "function") {
        try {
          const latestStatus = await api.server.getRemoteAgentUpdateStatus({
            executionTargetId,
            reconnectRequestId: admissionRequestId,
          });
          if (actionRevision === revision.current) setUpdateStatus(latestStatus);
        } catch {
          // Admission remains available as a deliberate server-side operation;
          // its exact readiness and replay checks are authoritative.
        }
      }
      const result = await api.server.connectRemoteAgent({
        executionTargetId,
        requestId: admissionRequestId,
        intent: "fresh",
        replace: true,
      });
      if (actionRevision !== revision.current) return;
      const usingFallback = result.outcome === "fallback" || Boolean(result.warning);
      setFallback(usingFallback);
      setSummary(result);
      useRemoteAccessStore.getState().recordRemoteConnection(executionTargetId, result);
      notifyRemoteAgentConnection(executionTargetId, result);
      setMessage(
        `Connected to ${usingFallback ? "backup version " : ""}${result.currentVersion}. Existing terminals and operations keep their original runtime.${result.cleanupMessage ? ` ${result.cleanupMessage}` : ""}`,
      );
      completeRemoteAgentAdmission(executionTargetId, admissionRequestId);
      requestId.current = undefined;
      setUpdateStatus(null);
    } catch (cause) {
      if (actionRevision === revision.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Remote agent action failed. Existing work is unchanged.",
        );
    } finally {
      if (actionRevision === revision.current) setBusy(false);
    }
  };

  const currentVersion = updateStatus?.currentVersion ?? summary?.currentVersion;
  const pendingVersion = updateStatus
    ? downloadedUpdateVersion(updateStatus)
    : (summary?.pendingVersion ?? null);
  const predecessorVersion = updateStatus
    ? updateStatus.predecessorVersion
    : (summary?.fallbackVersion ?? null);
  const connectionWarning = summary ? remoteAgentConnectionWarning(summary) : undefined;
  // Equal versions mean another build of that version (for example musl replacing gnu).
  const sameVersion = Boolean(pendingVersion && pendingVersion === currentVersion);

  return (
    <section
      aria-label="Remote agent versions"
      className="space-y-2 rounded-lg border border-border p-3 text-sm"
    >
      <dl className="grid grid-cols-2 gap-1">
        <dt>{LABELS.running}</dt>
        <dd>
          {currentVersion
            ? describeAgentBuild(
                currentVersion,
                {
                  targetTriple: updateStatus?.currentTargetTriple,
                  digestShort: updateStatus?.currentBuildDigestShort,
                },
                sameVersion,
              )
            : LABELS.notVerified}
        </dd>
        <dt>{LABELS.downloaded}</dt>
        <dd>
          {pendingVersion
            ? describeAgentBuild(
                pendingVersion,
                {
                  targetTriple: updateStatus?.pendingTargetTriple,
                  digestShort: updateStatus?.pendingBuildDigestShort,
                },
                sameVersion,
              )
            : LABELS.none}
        </dd>
        <dt>{LABELS.backup}</dt>
        <dd>{predecessorVersion ?? LABELS.none}</dd>
      </dl>
      {updateStatus ? (
        <p role="status" className={remoteAgentUpdateStatusTone(updateStatus.phase)}>
          {remoteAgentUpdateStatusMessage(updateStatus)}
        </p>
      ) : null}
      {updateStatus?.reason ? <p className="text-amber-600">{updateStatus.reason}</p> : null}
      <p className="text-xs text-muted-foreground">{REMOTE_AGENT_STATUS_FOOTER}</p>
      {connectionWarning ? (
        <p role="status" className="text-amber-600">
          {connectionWarning}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-blue-600">
          Preparing and connecting…
        </p>
      ) : message ? (
        <p role="status" className={fallback ? "text-amber-600" : "text-emerald-600"}>
          {message}
        </p>
      ) : null}
      {disconnected ? (
        <p role="status" className="text-muted-foreground">
          {REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="space-y-2 text-destructive">
          <p>{error}</p>
          {!error.includes("Direct SSH") ? <p>{REMOTE_AGENT_FAILURE_GUIDANCE}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || disconnected} onClick={() => void perform()}>
          Connect new session
        </Button>
      </div>
    </section>
  );
}
