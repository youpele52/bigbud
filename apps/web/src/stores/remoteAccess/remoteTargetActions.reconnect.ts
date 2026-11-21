/**
 * Reconnect = restart the bigbud remote service for an SSH workspace (with confirmation),
 * shared by every entry point. Requests are persisted so a reload reconciles them instead of
 * restarting twice; one poller per renderer follows their status.
 */
import type { ProjectId } from "@bigbud/contracts";
import type {
  ServerRemoteRestartPhase,
  ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart";

import { toastManager } from "../../components/ui/toast";
import { resolveRemoteExecutionFailureStatus } from "../../hooks/useRemoteExecutionAccessGate.shared";
import { isRemoteExecutionAuthPendingFor } from "../../hooks/useRemoteExecutionAccessGate.access";
import { readNativeApi } from "../../rpc/nativeApi";
import { useRemoteAccessStore } from "./remoteAccess.store";
import {
  type PersistedReconnectRequest,
  readReconnectRequests,
  removeReconnectRequest,
  saveReconnectRequest,
} from "./remoteTargetActions.persistence";
import { createReconnectPoller } from "./remoteTargetActions.poller";
import {
  clearReconnectRequestActive,
  markReconnectRequestActive,
  readProjects,
  resolveSshProject,
  setPendingReconnect,
  useRemoteTargetActionsStore,
} from "./remoteTargetActions.store";

const ACTIVE_PHASES = new Set<ServerRemoteRestartPhase>([
  "prepared",
  "stopping",
  "stopped",
  "starting",
]);

export function reconnectPhaseToast(
  phase: ServerRemoteRestartPhase,
  name: string,
  message: string,
) {
  if (phase === "ready")
    return { type: "success" as const, title: `Reconnected "${name}"`, description: message };
  if (phase === "unknown")
    return {
      type: "warning" as const,
      title: `Reconnect status is uncertain for "${name}"`,
      description: message,
    };
  if (phase === "failed")
    return { type: "error" as const, title: `Failed to reconnect "${name}"`, description: message };
  return {
    type: "loading" as const,
    title: `Reconnecting "${name}"`,
    description: message,
    timeout: 0,
  };
}

function isAuthRequired(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = resolveRemoteExecutionFailureStatus(message);
  return status.status === "auth_required" ? { message, status } : null;
}

function isMissingRestartRequest(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /remote restart request was not found/i.test(message);
}

const toastIds = new Map<string, ReturnType<typeof toastManager.add>>();
const reconciledRequestIds = new Set<string>();

function finish(request: PersistedReconnectRequest, result: ServerRestartRemoteAgentResult) {
  const toast = reconnectPhaseToast(result.phase, request.projectName, result.message);
  const existing = toastIds.get(request.requestId);
  if (existing) toastManager.update(existing, toast);
  else toastIds.set(request.requestId, toastManager.add(toast));
  if (!ACTIVE_PHASES.has(result.phase)) {
    clearReconnectRequestActive(request.requestId);
    if (result.phase !== "unknown") removeReconnectRequest(request.requestId);
  }
}

async function checkStatus(request: PersistedReconnectRequest): Promise<boolean> {
  const api = readNativeApi();
  if (!api) throw new Error("Backend is unavailable");
  try {
    const result = await api.server.getRemoteAgentRestartStatus({
      requestId: request.requestId,
      projectId: request.projectId,
      expectedWorkspaceExecutionTargetId: request.expectedWorkspaceExecutionTargetId,
    });
    finish(request, result);
    return ACTIVE_PHASES.has(result.phase);
  } catch (error) {
    if (isMissingRestartRequest(error)) {
      removeReconnectRequest(request.requestId);
      clearReconnectRequestActive(request.requestId);
      toastManager.add({
        type: "warning",
        title: `Reconnect request expired for "${request.projectName}"`,
        description: "The server no longer has a record of this request. You can reconnect again.",
      });
      return false;
    }
    // Preserve the operation identity and retry status checks after transient failures.
    throw error;
  }
}

const poller = createReconnectPoller(checkStatus);

/** Starts the poller for this renderer; the returned function stops it (host unmount). */
export function startReconnectReconciler(): () => void {
  poller.resume();
  return () => {
    poller.stop();
    reconciledRequestIds.clear();
  };
}

/** Reconciles persisted requests for known projects once each (after a reload or restart). */
export function reconcileStoredReconnectRequests(projectIds: ReadonlySet<ProjectId>) {
  for (const request of readReconnectRequests()) {
    if (projectIds.has(request.projectId) && !reconciledRequestIds.has(request.requestId)) {
      reconciledRequestIds.add(request.requestId);
      markReconnectRequestActive(request.requestId);
      void poller.reconcile(request);
    }
  }
}

async function startReconnect(request: PersistedReconnectRequest): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  markReconnectRequestActive(request.requestId);
  try {
    const result = await api.server.restartRemoteAgent({
      requestId: request.requestId,
      projectId: request.projectId,
      expectedWorkspaceExecutionTargetId: request.expectedWorkspaceExecutionTargetId,
    });
    finish(request, result);
    if (ACTIVE_PHASES.has(result.phase)) {
      void poller.reconcile(request);
    }
  } catch (error) {
    const auth = isAuthRequired(error);
    if (auth) {
      const opened = useRemoteAccessStore.getState().openAuthDialog({
        pendingAction: {
          executionTargetId: request.expectedWorkspaceExecutionTargetId,
          skipAgentVerification: true,
          onVerified: () => startReconnect(request),
          onCancel: () => {
            removeReconnectRequest(request.requestId);
            clearReconnectRequestActive(request.requestId);
          },
        },
        authMode: auth.status.authMode!,
        promptLabel: auth.status.promptLabel!,
      });
      if (!opened) {
        if (!isRemoteExecutionAuthPendingFor(request.expectedWorkspaceExecutionTargetId)) {
          toastManager.add({
            type: "warning",
            title: "Another remote authentication request is already pending.",
          });
        }
        removeReconnectRequest(request.requestId);
        clearReconnectRequestActive(request.requestId);
      }
      return;
    }
    await poller.reconcile(request);
    if (readReconnectRequests().some((entry) => entry.requestId === request.requestId)) {
      toastManager.add({
        type: "warning",
        title: `Reconnect status is uncertain for "${request.projectName}"`,
        description: "The request is still available for reconciliation; it was not started again.",
      });
    }
  }
}

/** Asks for confirmation (rendered by the global host) before restarting the remote service. */
export function requestReconnect(projectId: ProjectId) {
  const resolved = resolveSshProject(projectId);
  if (!resolved) return;
  setPendingReconnect({
    projectId,
    projectName: resolved.project.name,
    requestId: crypto.randomUUID(),
  });
}

export async function confirmReconnect(): Promise<void> {
  const pending = useRemoteTargetActionsStore.getState().pendingReconnect;
  if (!pending) return;
  const resolved = resolveSshProject(pending.projectId);
  if (!resolved) return;
  const request: PersistedReconnectRequest = {
    ...pending,
    expectedWorkspaceExecutionTargetId: resolved.executionTargetId,
  };
  setPendingReconnect(null);
  saveReconnectRequest(request);
  await startReconnect(request);
}

export function dismissReconnect() {
  setPendingReconnect(null);
}

/** Known project ids for the reconciler (live catalog). */
export function readKnownProjectIds(): ReadonlySet<ProjectId> {
  return new Set(readProjects().map((project) => project.id));
}
