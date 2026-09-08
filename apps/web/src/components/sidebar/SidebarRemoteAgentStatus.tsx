import { useEffect, useRef, useState } from "react";
import type {
  ServerRemoteAgentRuntimeSummary,
  ServerRemoteAgentUpdateStatus,
} from "@bigbud/contracts/server/server.ts";
import { readNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import {
  completeRemoteAgentAdmission,
  getRemoteAgentAdmissionRequestId,
  readRemoteAgentAdmissionRequestId,
} from "../../stores/remoteAccess/remoteAgentAdmissionRequest";
import {
  createRemoteProjectExecutionTargetId,
  type RemoteProjectDraft,
} from "./Sidebar.projects.logic";

export function remoteProjectAgentTarget(draft: RemoteProjectDraft): string | null {
  try {
    return draft.host.trim() ? createRemoteProjectExecutionTargetId(draft) : null;
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
  useEffect(() => {
    let active = true;
    const observedRevision = ++revision.current;
    requestId.current = readRemoteAgentAdmissionRequestId(executionTargetId);
    setSummary(null);
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
      .catch(() => {
        if (active && observedRevision === revision.current)
          setError("Remote agent status is unavailable. Verify the SSH connection to retry.");
      });
    return () => {
      active = false;
    };
  }, [executionTargetId, cwd]);

  const perform = async () => {
    if (busy) return;
    const api = readNativeApi();
    if (!api) return;
    const actionRevision = ++revision.current;
    setBusy(true);
    setError(null);
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
      });
      if (actionRevision !== revision.current) return;
      const usingFallback = result.outcome === "fallback";
      setFallback(usingFallback);
      setSummary(result);
      useRemoteAccessStore.getState().recordRemoteConnection(executionTargetId, result);
      setMessage(
        `Connected to ${usingFallback ? "healthy fallback " : ""}${result.currentVersion}. Existing terminals and operations keep their original runtime.`,
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
    ? updateStatus.pendingVersion
    : (summary?.pendingVersion ?? null);
  const predecessorVersion = updateStatus
    ? updateStatus.predecessorVersion
    : (summary?.fallbackVersion ?? null);

  return (
    <section
      aria-label="Remote agent versions"
      className="space-y-2 rounded-lg border border-border p-3 text-sm"
    >
      <dl className="grid grid-cols-2 gap-1">
        <dt>Current connection</dt>
        <dd>{currentVersion ?? "Not verified"}</dd>
        <dt>Pending update</dt>
        <dd>{pendingVersion ?? "None"}</dd>
        <dt>Healthy fallback</dt>
        <dd>{predecessorVersion ?? "None verified"}</dd>
      </dl>
      {updateStatus ? (
        <p
          role="status"
          className={
            updateStatus.phase === "failed-using-stable" ||
            updateStatus.phase === "verification-unavailable" ||
            updateStatus.phase === "waiting-for-capacity" ||
            updateStatus.phase === "capacity-noncompliant"
              ? "text-amber-600"
              : updateStatus.phase === "installing" ||
                  updateStatus.phase === "checking-health" ||
                  updateStatus.phase === "reserved"
                ? "text-blue-600"
                : "text-emerald-600"
          }
        >
          {remoteAgentUpdateStatusMessage(updateStatus)}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Retained work stays on its original runtime, including after reconnect.
      </p>
      {summary?.outcome === "fallback" ? (
        <p role="status" className="text-amber-600">
          Using healthy fallback {summary.currentVersion}. Candidate admission:{" "}
          {summary.failureCode ?? "unavailable"}.
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-blue-600">
          Working…
        </p>
      ) : message ? (
        <p role="status" className={fallback ? "text-amber-600" : "text-emerald-600"}>
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => void perform()}>
          Connect new session
        </Button>
      </div>
    </section>
  );
}

function remoteAgentUpdateStatusMessage(status: ServerRemoteAgentUpdateStatus): string {
  switch (status.phase) {
    case "installing":
      return `Installing verified update ${status.pendingVersion ?? ""}. Existing work is unchanged.`;
    case "checking-health":
      return `Checking update ${status.pendingVersion ?? ""} before it can be selected.`;
    case "ready-for-next-reconnect":
      return `Update ${status.pendingVersion ?? ""} is ready for the next deliberate connection.`;
    case "waiting-for-capacity":
      return `Update ${status.pendingVersion ?? ""} is waiting for a safe storage slot.`;
    case "capacity-noncompliant":
      return "Update waiting: the remote installation has uncertain or excess builds.";
    case "failed-using-stable":
      return `Update unavailable; continuing with stable ${status.currentVersion ?? "fallback"}.`;
    case "verification-unavailable":
      return "Update verification is temporarily unavailable; existing work is unchanged.";
    case "connected":
      return status.reconnectOutcome === "fallback"
        ? `Connected using verified fallback ${status.currentVersion ?? ""}.`
        : "Connected to the current stable remote agent.";
    case "waiting-for-authentication":
      return "Update preparation will resume after remote authentication.";
    case "reserved":
      return "A safe storage slot is reserved for the verified update.";
    case "idle":
      return "Remote update preparation is idle.";
  }
}
