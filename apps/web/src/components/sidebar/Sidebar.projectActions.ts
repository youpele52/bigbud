import {
  useCallback,
  useState,
  type PointerEvent,
  type MouseEvent,
  type KeyboardEvent,
} from "react";
import { type DragCancelEvent, type DragStartEvent, type DragEndEvent } from "@dnd-kit/core";
import {
  isBuiltInChatsProject,
  ThreadId,
  type ProjectId,
  type ThreadId as ThreadIdType,
} from "@bigbud/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { isMacPlatform, newCommandId } from "../../lib/utils";
import { useStore } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import { readNativeApi } from "../../rpc/nativeApi";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useRemoteExecutionAccessGate } from "../../hooks/useRemoteExecutionAccessGate";
import { toastManager } from "../ui/toast";
import { getFallbackThreadIdAfterDelete, isContextMenuPointerDown } from "./Sidebar.logic";
import { isRemoteExecutionTargetId } from "./Sidebar.projects.logic";
import { useSidebarProjectRenameActions } from "./Sidebar.projectActions.rename";
import type {
  SidebarProjectActionsInput,
  SidebarProjectActionsOutput,
} from "./Sidebar.projectActions.types";

export type {
  SidebarProjectActionsInput,
  SidebarProjectActionsOutput,
} from "./Sidebar.projectActions.types";

/** Encapsulates all project-level actions for the sidebar. */
export function useSidebarProjectActions({
  projects,
  threadIdsByProjectId,
  sidebarProjects,
  appSettings,
  dragInProgressRef,
  suppressProjectClickAfterDragRef,
  suppressProjectClickForContextMenuRef,
  selectedThreadIdsSize,
  clearSelection,
  copyPathToClipboard,
  cancelThreadRename,
}: SidebarProjectActionsInput): SidebarProjectActionsOutput {
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const setSelectedProject = useUiStateStore((store) => store.setSelectedProject);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const verifiedExecutionTargetIds = useRemoteAccessStore(
    (store) => store.verifiedExecutionTargetIds,
  );
  const { beginRemoteExecutionTargetAccessCheck } = useRemoteExecutionAccessGate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const navigate = useNavigate();

  const [pendingProjectDeleteConfirmation, setPendingProjectDeleteConfirmation] = useState<{
    projectId: ProjectId;
    projectName: string;
    threadCount: number;
  } | null>(null);
  const {
    renamingProjectId,
    setRenamingProjectId,
    renamingProjectTitle,
    setRenamingProjectTitle,
    projectRenamingCommittedRef,
    cancelProjectRename,
    onProjectRenamingInputMount,
    hasProjectRenameCommitted,
    markProjectRenameCommitted,
    commitProjectRename,
  } = useSidebarProjectRenameActions();

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

      await api.orchestration.dispatchCommand({
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
      const message = error instanceof Error ? error.message : "Unknown error removing project.";
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

  const handleProjectContextMenuAsync = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;
      if (isBuiltInChatsProject(projectId)) {
        return;
      }

      const menuItems = [
        { id: "rename", label: "Rename project" },
        ...(project.cwd ? ([{ id: "copy-path", label: "Copy Project Path" }] as const) : []),
        { id: "delete", label: "Remove project", destructive: true },
      ];
      const clicked = await api.contextMenu.show(menuItems, position);
      if (clicked === "rename") {
        cancelThreadRename();
        setRenamingProjectId(projectId);
        setRenamingProjectTitle(project.name);
        projectRenamingCommittedRef.current = false;
        return;
      }
      if (clicked === "copy-path") {
        if (!project.cwd) {
          return;
        }
        copyPathToClipboard(project.cwd, { path: project.cwd });
        return;
      }
      if (clicked !== "delete") return;

      requestProjectDelete(projectId);
    },
    [
      cancelThreadRename,
      copyPathToClipboard,
      projectRenamingCommittedRef,
      projects,
      requestProjectDelete,
      setRenamingProjectId,
      setRenamingProjectTitle,
    ],
  );

  const handleProjectContextMenu = useCallback(
    (projectId: ProjectId, position: { x: number; y: number }) => {
      suppressProjectClickForContextMenuRef.current = true;
      void handleProjectContextMenuAsync(projectId, position);
    },
    [handleProjectContextMenuAsync, suppressProjectClickForContextMenuRef],
  );

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjects.find((project) => project.id === active.id);
      const overProject = sidebarProjects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [appSettings.sidebarProjectSortOrder, dragInProgressRef, reorderProjects, sidebarProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder, dragInProgressRef, suppressProjectClickAfterDragRef],
  );

  const handleProjectDragCancel = useCallback(
    (_event: DragCancelEvent) => {
      dragInProgressRef.current = false;
    },
    [dragInProgressRef],
  );

  const handleProjectTitlePointerDownCapture = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        event.stopPropagation();
      }
      suppressProjectClickAfterDragRef.current = false;
    },
    [suppressProjectClickAfterDragRef, suppressProjectClickForContextMenuRef],
  );

  const handleProjectTitleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIdsSize > 0) {
        clearSelection();
      }

      const project = projects.find((entry) => entry.id === projectId);
      const executionTargetId = project ? resolveWorkspaceExecutionTargetId(project) : null;
      const isRemoteProject =
        executionTargetId !== null && isRemoteExecutionTargetId(executionTargetId);
      const isVerifiedRemoteTarget =
        isRemoteProject && verifiedExecutionTargetIds[executionTargetId];

      if (!project || !isRemoteProject || isVerifiedRemoteTarget) {
        setSelectedProject(projectId);
        toggleProject(projectId);
        return;
      }

      void beginRemoteExecutionTargetAccessCheck({
        executionTargetId,
        ...(project.cwd ? { cwd: project.cwd } : {}),
        onVerified: () => {
          setSelectedProject(projectId);
          setProjectExpanded(projectId, true);
        },
      });
    },
    [
      clearSelection,
      dragInProgressRef,
      beginRemoteExecutionTargetAccessCheck,
      projects,
      selectedThreadIdsSize,
      setProjectExpanded,
      setSelectedProject,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
      toggleProject,
      verifiedExecutionTargetIds,
    ],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      const project = projects.find((entry) => entry.id === projectId);
      const executionTargetId = project ? resolveWorkspaceExecutionTargetId(project) : null;
      const isRemoteProject =
        executionTargetId !== null && isRemoteExecutionTargetId(executionTargetId);
      const isVerifiedRemoteTarget =
        isRemoteProject && verifiedExecutionTargetIds[executionTargetId];

      if (!project || !isRemoteProject || isVerifiedRemoteTarget) {
        setSelectedProject(projectId);
        toggleProject(projectId);
        return;
      }

      void beginRemoteExecutionTargetAccessCheck({
        executionTargetId,
        ...(project.cwd ? { cwd: project.cwd } : {}),
        onVerified: () => {
          setSelectedProject(projectId);
          setProjectExpanded(projectId, true);
        },
      });
    },
    [
      dragInProgressRef,
      beginRemoteExecutionTargetAccessCheck,
      projects,
      setProjectExpanded,
      setSelectedProject,
      toggleProject,
      verifiedExecutionTargetIds,
    ],
  );

  return {
    renamingProjectId,
    renamingProjectTitle,
    setRenamingProjectTitle,
    onProjectRenamingInputMount,
    hasProjectRenameCommitted,
    markProjectRenameCommitted,
    commitProjectRename,
    cancelProjectRename,
    pendingProjectDeleteConfirmation,
    dismissPendingProjectDeleteConfirmation,
    confirmPendingProjectDelete,
    requestProjectDelete,
    handleProjectContextMenu,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleProjectTitlePointerDownCapture,
    handleProjectTitleClick,
    handleProjectTitleKeyDown,
  };
}
