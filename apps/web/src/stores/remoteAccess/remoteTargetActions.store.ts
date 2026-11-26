/**
 * Shared state for the remote-target Reconnect / Disconnect / Connect actions.
 *
 * The workspace menu, thread menu, composer picker and thread gate all drive the same actions
 * (`remoteTargetActions.reconnect.ts`, `remoteTargetActions.connection.ts`), and the global
 * `RemoteTargetDialogsHost` renders their confirmations from this store, so every entry point
 * shows the same dialogs even when the sidebar is closed (mobile `Sheet`).
 */
import type { ProjectId } from "@bigbud/contracts";
import { create } from "zustand";

import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import type { Project } from "../../models/types";
import { isSshExecutionTargetId } from "../../components/sidebar/Sidebar.remoteWorkspaces.logic";
import type { PendingDisconnectConfirmation } from "../../components/sidebar/Sidebar.projectActions.connection.logic";
import { useStore } from "../main";
import { readReconnectRequests } from "./remoteTargetActions.persistence";

export interface PendingReconnectConfirmation {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly requestId: string;
}

interface RemoteTargetActionsState {
  pendingReconnect: PendingReconnectConfirmation | null;
  pendingDisconnect: PendingDisconnectConfirmation | null;
  /** Restart requests started (or reconciled) in this renderer and not yet settled. */
  activeReconnectRequestIds: Record<string, true>;
}

export const useRemoteTargetActionsStore = create<RemoteTargetActionsState>()(() => ({
  pendingReconnect: null,
  pendingDisconnect: null,
  activeReconnectRequestIds: {},
}));

export function setPendingReconnect(pendingReconnect: PendingReconnectConfirmation | null) {
  useRemoteTargetActionsStore.setState({ pendingReconnect });
}

export function setPendingDisconnect(pendingDisconnect: PendingDisconnectConfirmation | null) {
  useRemoteTargetActionsStore.setState({ pendingDisconnect });
}

export function markReconnectRequestActive(requestId: string) {
  useRemoteTargetActionsStore.setState((state) =>
    state.activeReconnectRequestIds[requestId]
      ? state
      : { activeReconnectRequestIds: { ...state.activeReconnectRequestIds, [requestId]: true } },
  );
}

export function clearReconnectRequestActive(requestId: string) {
  useRemoteTargetActionsStore.setState((state) => {
    if (!state.activeReconnectRequestIds[requestId]) return state;
    const next = { ...state.activeReconnectRequestIds };
    delete next[requestId];
    return { activeReconnectRequestIds: next };
  });
}

/** Projects are read live, so actions started from any entry point see the current catalog. */
export function readProjects(): readonly Project[] {
  return useStore.getState().projects;
}

export function resolveSshProject(projectId: ProjectId) {
  const project = readProjects().find((entry) => entry.id === projectId);
  const executionTargetId = project ? resolveWorkspaceExecutionTargetId(project) : null;
  return project && executionTargetId && isSshExecutionTargetId(executionTargetId)
    ? { project, executionTargetId }
    : null;
}

function selectIsReconnectPending(state: RemoteTargetActionsState, projectId: ProjectId): boolean {
  if (state.pendingReconnect?.projectId === projectId) return true;
  const requestId = readReconnectRequests().find(
    (request) => request.projectId === projectId,
  )?.requestId;
  return requestId !== undefined && state.activeReconnectRequestIds[requestId] === true;
}

/** True while a Reconnect for this project is awaiting confirmation or still running. */
export function isReconnectPending(projectId: ProjectId): boolean {
  return selectIsReconnectPending(useRemoteTargetActionsStore.getState(), projectId);
}

export function useIsReconnectPending(projectId: ProjectId | null | undefined): boolean {
  return useRemoteTargetActionsStore((state) =>
    projectId ? selectIsReconnectPending(state, projectId) : false,
  );
}
