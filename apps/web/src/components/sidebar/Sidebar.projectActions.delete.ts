import { useCallback, useState } from "react";
import { ThreadId, type ProjectId, type ThreadId as ThreadIdType } from "@bigbud/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { newCommandId } from "../../lib/utils";
import { dispatchCommandWithOutcomeRecovery } from "../../lib/orchestrationCommandRecovery";
import { useStore } from "../../stores/main";
import { readNativeApi } from "../../rpc/nativeApi";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { toastManager } from "../ui/toast";
import { getFallbackThreadIdAfterDelete } from "./Sidebar.logic";
import { isRemoteExecutionTargetId } from "./Sidebar.remoteWorkspaces.logic";
import type { SidebarProjectActionsInput } from "./Sidebar.projectActions.types";

export function useSidebarProjectDeleteActions({
  projects,
  threadIdsByProjectId,
  appSettings,
}: Pick<SidebarProjectActionsInput, "projects" | "threadIdsByProjectId" | "appSettings">) {
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const navigate = useNavigate();
  const [pendingProjectDeleteConfirmation, setPendingProjectDeleteConfirmation] = useState<{
    projectId: ProjectId;
    projectName: string;
    threadCount: number;
    isRemoteWorkspace: boolean;
  } | null>(null);
  const dismissPendingProjectDeleteConfirmation = useCallback(() => {
    setPendingProjectDeleteConfirmation(null);
  }, []);

  const requestProjectDelete = useCallback(
    (projectId: ProjectId) => {
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      setPendingProjectDeleteConfirmation({
        projectId,
        projectName: project.name,
        isRemoteWorkspace: isRemoteExecutionTargetId(resolveWorkspaceExecutionTargetId(project)),
        threadCount: threadIdsByProjectId[projectId]?.length ?? 0,
      });
    },
    [projects, threadIdsByProjectId],
  );
  const confirmPendingProjectDelete = useCallback(async () => {
    if (!pendingProjectDeleteConfirmation) {
      return;
    }

    const { projectId, projectName } = pendingProjectDeleteConfirmation;
    setPendingProjectDeleteConfirmation(null);

    const api = readNativeApi();
    if (!api) {
      return;
    }

    try {
      const { threads } = useStore.getState();
      const projectThreadIdSet = new Set(threadIdsByProjectId[projectId] ?? []);
      const projectThreads = threads.filter(
        (thread) => thread.projectId === projectId && projectThreadIdSet.has(thread.id),
      );
      const deletedThreadIds = new Set<ThreadIdType>(projectThreads.map((thread) => thread.id));

      const fallbackThreadId =
        routeThreadId && deletedThreadIds.has(routeThreadId)
          ? getFallbackThreadIdAfterDelete({
              threads,
              deletedThreadId: routeThreadId,
              deletedThreadIds,
              sortOrder: appSettings.sidebarThreadSortOrder,
            })
          : null;

      await dispatchCommandWithOutcomeRecovery(api, {
        type: "project.delete",
        commandId: newCommandId(),
        projectId,
      });

      if (routeThreadId && deletedThreadIds.has(routeThreadId)) {
        if (fallbackThreadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          await navigate({ to: "/", replace: true });
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unknown error removing ${pendingProjectDeleteConfirmation.isRemoteWorkspace ? "remote workspace" : "project"}.`;
      console.error("Failed to remove project", { projectId, error });
      toastManager.add({
        type: "error",
        title: `Failed to remove "${projectName}"`,
        description: message,
      });
    }
  }, [
    appSettings.sidebarThreadSortOrder,
    navigate,
    pendingProjectDeleteConfirmation,
    routeThreadId,
    threadIdsByProjectId,
  ]);
  return {
    pendingProjectDeleteConfirmation,
    dismissPendingProjectDeleteConfirmation,
    requestProjectDelete,
    confirmPendingProjectDelete,
  };
}
