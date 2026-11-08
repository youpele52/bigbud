import { useCallback, useState } from "react";
import type { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import type { Project } from "../../models/types";
import { useRemoteExecutionAccessGate } from "../../hooks/useRemoteExecutionAccessGate";
import {
  connectRemoteExecutionTarget,
  disconnectRemoteExecutionTarget,
} from "../../hooks/useRemoteExecutionAccessGate.connection";
import { useStore } from "../../stores/main";
import { isExecutionTargetVerified } from "../../stores/remoteAccess/remoteAccess.store";
import { selectThreadTerminalState, useTerminalStateStore } from "../../stores/terminal";
import { toastManager } from "../ui/toast";
import {
  type PendingDisconnectConfirmation,
  shouldConfirmDisconnect,
  summarizeExecutionTargetActivity,
} from "./Sidebar.projectActions.connection.logic";
import { isSshExecutionTargetId } from "./Sidebar.remoteWorkspaces.logic";
import { mergeRunningTerminalIds } from "./SidebarThreadRow.status";

function readRunningTerminalIds(threadId: ThreadId): readonly string[] {
  const state = useTerminalStateStore.getState();
  return mergeRunningTerminalIds(
    selectThreadTerminalState(state.terminalStateByThreadId, threadId).runningTerminalIds,
    selectThreadTerminalState(state.panelTerminalStateByThreadId, threadId).runningTerminalIds,
  );
}

function resolveSshProject(projects: readonly Project[], projectId: ProjectId) {
  const project = projects.find((entry) => entry.id === projectId);
  const executionTargetId = project ? resolveWorkspaceExecutionTargetId(project) : null;
  return project && executionTargetId && isSshExecutionTargetId(executionTargetId)
    ? { project, executionTargetId }
    : null;
}

/** User-initiated Disconnect/Connect for SSH workspaces; the flag is per execution target. */
export function useSidebarProjectConnectionActions(projects: Project[]) {
  const [pending, setPending] = useState<PendingDisconnectConfirmation | null>(null);
  const { beginRemoteExecutionTargetAccessCheck } = useRemoteExecutionAccessGate();

  const requestDisconnect = useCallback(
    (projectId: ProjectId) => {
      const resolved = resolveSshProject(projects, projectId);
      if (!resolved) return;
      const { project, executionTargetId } = resolved;
      const activity = summarizeExecutionTargetActivity({
        executionTargetId,
        projectId,
        projects,
        threads: Object.values(useStore.getState().sidebarThreadsById),
        runningTerminalIds: readRunningTerminalIds,
      });
      if (shouldConfirmDisconnect(activity)) {
        setPending({ ...activity, projectId, projectName: project.name, executionTargetId });
        return;
      }
      void disconnectRemoteExecutionTarget({ executionTargetId, name: project.name });
    },
    [projects],
  );

  const confirmDisconnect = useCallback(async () => {
    if (!pending) return;
    setPending(null);
    await disconnectRemoteExecutionTarget({
      executionTargetId: pending.executionTargetId,
      name: pending.projectName,
    });
  }, [pending]);

  const dismissDisconnect = useCallback(() => setPending(null), []);

  const requestConnect = useCallback(
    async (projectId: ProjectId) => {
      const resolved = resolveSshProject(projects, projectId);
      if (!resolved) return;
      const { project, executionTargetId } = resolved;
      const connected = await connectRemoteExecutionTarget({
        executionTargetId,
        name: project.name,
      });
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
    },
    [beginRemoteExecutionTargetAccessCheck, projects],
  );

  return {
    pendingDisconnect: pending,
    requestDisconnect,
    confirmDisconnect,
    dismissDisconnect,
    requestConnect,
  };
}
