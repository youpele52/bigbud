import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectId } from "@bigbud/contracts";
import type {
  ServerRemoteRestartPhase,
  ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart";
import type { Project } from "../../models/types";
import { readNativeApi } from "../../rpc/nativeApi";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { resolveRemoteExecutionFailureStatus } from "../../hooks/useRemoteExecutionAccessGate.shared";
import { isSshExecutionTargetId } from "./Sidebar.projects.logic";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import { toastManager } from "../ui/toast";
import {
  readReconnectRequests,
  removeReconnectRequest,
  saveReconnectRequest,
  type PersistedReconnectRequest,
} from "./Sidebar.projectActions.reconnect.persistence";

type Confirmation = {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly requestId: string;
};

const ACTIVE_PHASES = new Set<ServerRemoteRestartPhase>([
  "prepared",
  "stopping",
  "stopped",
  "starting",
]);

function phaseToast(phase: ServerRemoteRestartPhase, name: string, message: string) {
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

export function useSidebarProjectReconnectActions(projects: Project[]) {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const [activeRequestIds, setActiveRequestIds] = useState<Set<string>>(new Set());
  const toastIds = useRef(new Map<string, ReturnType<typeof toastManager.add>>());
  const startRef = useRef<(request: PersistedReconnectRequest) => Promise<void>>(async () => {});
  const reconciledRequestIds = useRef(new Set<string>());

  const finish = useCallback(
    (request: PersistedReconnectRequest, result: ServerRestartRemoteAgentResult) => {
      const toast = phaseToast(result.phase, request.projectName, result.message);
      const existing = toastIds.current.get(request.requestId);
      if (existing) toastManager.update(existing, toast);
      else toastIds.current.set(request.requestId, toastManager.add(toast));
      if (!ACTIVE_PHASES.has(result.phase)) {
        setActiveRequestIds((ids) => {
          const next = new Set(ids);
          next.delete(request.requestId);
          return next;
        });
        if (result.phase !== "unknown") removeReconnectRequest(request.requestId);
      }
    },
    [],
  );

  const reconcile = useCallback(
    async (request: PersistedReconnectRequest) => {
      const api = readNativeApi();
      if (!api) return;
      try {
        const result = await api.server.getRemoteAgentRestartStatus({
          requestId: request.requestId,
          projectId: request.projectId,
          expectedWorkspaceExecutionTargetId: request.expectedWorkspaceExecutionTargetId,
        });
        finish(request, result);
        if (ACTIVE_PHASES.has(result.phase)) {
          window.setTimeout(() => void reconcile(request), 1_000);
        }
      } catch {
        // Keep the durable request. A later reload can query the same operation.
      }
    },
    [finish],
  );

  useEffect(() => {
    const knownProjects = new Map(projects.map((project) => [project.id, project]));
    for (const request of readReconnectRequests()) {
      if (
        knownProjects.has(request.projectId) &&
        !reconciledRequestIds.current.has(request.requestId)
      ) {
        reconciledRequestIds.current.add(request.requestId);
        setActiveRequestIds((ids) => new Set(ids).add(request.requestId));
        void reconcile(request);
      }
    }
  }, [projects, reconcile]);

  const start = useCallback(
    async (request: PersistedReconnectRequest) => {
      const api = readNativeApi();
      if (!api) return;
      setActiveRequestIds((ids) => new Set(ids).add(request.requestId));
      try {
        const result = await api.server.restartRemoteAgent({
          requestId: request.requestId,
          projectId: request.projectId,
          expectedWorkspaceExecutionTargetId: request.expectedWorkspaceExecutionTargetId,
        });
        finish(request, result);
        if (ACTIVE_PHASES.has(result.phase)) {
          window.setTimeout(() => void reconcile(request), 1_000);
        }
      } catch (error) {
        const auth = isAuthRequired(error);
        if (auth) {
          const opened = useRemoteAccessStore.getState().openAuthDialog({
            pendingAction: {
              executionTargetId: request.expectedWorkspaceExecutionTargetId,
              skipAgentVerification: true,
              onVerified: () => startRef.current(request),
              onCancel: () => {
                removeReconnectRequest(request.requestId);
                setActiveRequestIds((ids) => {
                  const next = new Set(ids);
                  next.delete(request.requestId);
                  return next;
                });
              },
            },
            authMode: auth.status.authMode!,
            promptLabel: auth.status.promptLabel!,
          });
          if (!opened) {
            toastManager.add({
              type: "warning",
              title: "Another remote authentication request is already pending.",
            });
          }
          return;
        }
        await reconcile(request);
        if (readReconnectRequests().some((entry) => entry.requestId === request.requestId)) {
          toastManager.add({
            type: "warning",
            title: `Reconnect status is uncertain for "${request.projectName}"`,
            description:
              "The request is still available for reconciliation; it was not started again.",
          });
        }
      }
    },
    [finish, reconcile],
  );
  startRef.current = start;

  const request = useCallback(
    (projectId: ProjectId) => {
      const project = projects.find((entry) => entry.id === projectId);
      const target = project && resolveWorkspaceExecutionTargetId(project);
      if (project && target && isSshExecutionTargetId(target)) {
        setPending({ projectId, projectName: project.name, requestId: crypto.randomUUID() });
      }
    },
    [projects],
  );

  const confirm = useCallback(async () => {
    if (!pending) return;
    const project = projects.find((entry) => entry.id === pending.projectId);
    const target = project && resolveWorkspaceExecutionTargetId(project);
    if (!project || !target || !isSshExecutionTargetId(target)) return;
    const request: PersistedReconnectRequest = {
      ...pending,
      expectedWorkspaceExecutionTargetId: target,
    };
    setPending(null);
    saveReconnectRequest(request);
    await start(request);
  }, [pending, projects, start]);

  const dismiss = useCallback(() => setPending(null), []);
  const isPending = useCallback(
    (projectId: ProjectId) => {
      if (pending?.projectId === projectId) return true;
      return projects.some(
        (project) =>
          project.id === projectId &&
          activeRequestIds.has(
            readReconnectRequests().find((request) => request.projectId === projectId)?.requestId ??
              "",
          ),
      );
    },
    [activeRequestIds, pending, projects],
  );

  return {
    pendingReconnect: pending,
    requestReconnect: request,
    isReconnectPending: isPending,
    dismissReconnect: dismiss,
    confirmReconnect: confirm,
  };
}
