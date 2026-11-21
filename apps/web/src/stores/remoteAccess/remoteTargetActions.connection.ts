/**
 * User-initiated Disconnect / Connect for SSH workspaces, shared by every entry point. The flag
 * is per execution target; Disconnect confirms first only when it would cut off running work.
 */
import type { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";

import {
  shouldConfirmDisconnect,
  summarizeExecutionTargetActivity,
} from "../../components/sidebar/Sidebar.projectActions.connection.logic";
import { mergeRunningTerminalIds } from "../../components/sidebar/SidebarThreadRow.status";
import { toastManager } from "../../components/ui/toast";
import { beginRemoteExecutionTargetAccessCheck } from "../../hooks/useRemoteExecutionAccessGate.access";
import {
  connectRemoteExecutionTarget,
  disconnectRemoteExecutionTarget,
} from "../../hooks/useRemoteExecutionAccessGate.connection";
import { useStore } from "../main";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminal";
import { isExecutionTargetVerified } from "./remoteAccess.store";
import {
  readProjects,
  resolveSshProject,
  setPendingDisconnect,
  useRemoteTargetActionsStore,
} from "./remoteTargetActions.store";

function readRunningTerminalIds(threadId: ThreadId): readonly string[] {
  const state = useTerminalStateStore.getState();
  return mergeRunningTerminalIds(
    selectThreadTerminalState(state.terminalStateByThreadId, threadId).runningTerminalIds,
    selectThreadTerminalState(state.panelTerminalStateByThreadId, threadId).runningTerminalIds,
  );
}

export function requestDisconnect(projectId: ProjectId) {
  const resolved = resolveSshProject(projectId);
  if (!resolved) return;
  const { project, executionTargetId } = resolved;
  const activity = summarizeExecutionTargetActivity({
    executionTargetId,
    projectId,
    projects: readProjects(),
    threads: Object.values(useStore.getState().sidebarThreadsById),
    runningTerminalIds: readRunningTerminalIds,
  });
  if (shouldConfirmDisconnect(activity)) {
    setPendingDisconnect({ ...activity, projectId, projectName: project.name, executionTargetId });
    return;
  }
  void disconnectRemoteExecutionTarget({ executionTargetId, name: project.name });
}

export async function confirmDisconnect(): Promise<void> {
  const pending = useRemoteTargetActionsStore.getState().pendingDisconnect;
  if (!pending) return;
  setPendingDisconnect(null);
  await disconnectRemoteExecutionTarget({
    executionTargetId: pending.executionTargetId,
    name: pending.projectName,
  });
}

export function dismissDisconnect() {
  setPendingDisconnect(null);
}

/** Clears the user's Disconnect, then re-establishes access (auth dialog when needed). */
export async function requestConnect(projectId: ProjectId): Promise<void> {
  const resolved = resolveSshProject(projectId);
  if (!resolved) return;
  const { project, executionTargetId } = resolved;
  const connected = await connectRemoteExecutionTarget({ executionTargetId, name: project.name });
  if (!connected) return;
  await beginRemoteExecutionTargetAccessCheck({
    executionTargetId,
    ...(project.cwd ? { cwd: project.cwd } : {}),
    onVerified: () => {
      // A slow check resumes in the background and reports through its own toast.
      if (!isExecutionTargetVerified(executionTargetId)) return;
      toastManager.add({ type: "success", title: `Connected "${project.name}"` });
    },
  });
}
