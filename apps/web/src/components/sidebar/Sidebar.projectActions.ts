import { useSidebarProjectDeleteActions } from "./Sidebar.projectActions.delete";
import { useCallback, type PointerEvent, type MouseEvent, type KeyboardEvent } from "react";
import { type DragCancelEvent, type DragStartEvent, type DragEndEvent } from "@dnd-kit/core";
import { isBuiltInChatsProject, type ProjectId } from "@bigbud/contracts";
import { isMacPlatform } from "../../lib/utils";
import { useUiStateStore } from "../../stores/ui";
import {
  isExecutionTargetDisconnected,
  useRemoteAccessStore,
} from "../../stores/remoteAccess/remoteAccess.store";
import { readNativeApi } from "../../rpc/nativeApi";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useRemoteExecutionAccessGate } from "../../hooks/useRemoteExecutionAccessGate";
import { isContextMenuPointerDown } from "./Sidebar.logic";
import { isRemoteExecutionTargetId } from "./Sidebar.remoteWorkspaces.logic";
import { useSidebarProjectRenameActions } from "./Sidebar.projectActions.rename";
import type {
  SidebarProjectActionsInput,
  SidebarProjectActionsOutput,
} from "./Sidebar.projectActions.types";
import { useSidebarProjectReconnectActions } from "./Sidebar.projectActions.reconnect";
import { useSidebarProjectConnectionActions } from "./Sidebar.projectActions.connection";
import { buildProjectContextMenuItems } from "./Sidebar.projectActions.menu";

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
  openRemoteWorkspaceEditDialog,
}: SidebarProjectActionsInput): SidebarProjectActionsOutput {
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const setSelectedProject = useUiStateStore((store) => store.setSelectedProject);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const verifiedExecutionTargetIds = useRemoteAccessStore(
    (store) => store.verifiedExecutionTargetIds,
  );
  const { beginRemoteExecutionTargetAccessCheck } = useRemoteExecutionAccessGate();
  const reconnect = useSidebarProjectReconnectActions(projects);
  const connection = useSidebarProjectConnectionActions(projects);
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
  const {
    pendingProjectDeleteConfirmation,
    dismissPendingProjectDeleteConfirmation,
    requestProjectDelete,
    confirmPendingProjectDelete,
  } = useSidebarProjectDeleteActions({
    projects,
    threadIdsByProjectId,
    appSettings,
  });
  const handleProjectContextMenuAsync = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;
      if (isBuiltInChatsProject(projectId)) {
        return;
      }

      const menuItems = buildProjectContextMenuItems({
        project,
        reconnectDisabled: reconnect.isReconnectPending(projectId),
        disconnected: isExecutionTargetDisconnected(resolveWorkspaceExecutionTargetId(project)),
      });
      const clicked = await api.contextMenu.show(menuItems, position);
      if (clicked === "reconnect") {
        reconnect.requestReconnect(projectId);
        return;
      }
      if (clicked === "disconnect") {
        connection.requestDisconnect(projectId);
        return;
      }
      if (clicked === "connect") {
        await connection.requestConnect(projectId);
        return;
      }
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
      if (clicked === "edit-ssh") {
        openRemoteWorkspaceEditDialog(project);
        return;
      }
      if (clicked !== "delete") return;

      requestProjectDelete(projectId);
    },
    [
      cancelThreadRename,
      copyPathToClipboard,
      openRemoteWorkspaceEditDialog,
      projectRenamingCommittedRef,
      projects,
      requestProjectDelete,
      setRenamingProjectId,
      setRenamingProjectTitle,
      reconnect,
      connection,
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
      const isRemoteWorkspace =
        executionTargetId !== null && isRemoteExecutionTargetId(executionTargetId);
      const isVerifiedRemoteTarget =
        isRemoteWorkspace && verifiedExecutionTargetIds[executionTargetId];

      if (!project || !isRemoteWorkspace || isVerifiedRemoteTarget) {
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
      const isRemoteWorkspace =
        executionTargetId !== null && isRemoteExecutionTargetId(executionTargetId);
      const isVerifiedRemoteTarget =
        isRemoteWorkspace && verifiedExecutionTargetIds[executionTargetId];

      if (!project || !isRemoteWorkspace || isVerifiedRemoteTarget) {
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
    pendingReconnect: reconnect.pendingReconnect,
    dismissReconnect: reconnect.dismissReconnect,
    confirmReconnect: reconnect.confirmReconnect,
    pendingDisconnect: connection.pendingDisconnect,
    dismissDisconnect: connection.dismissDisconnect,
    confirmDisconnect: connection.confirmDisconnect,
    handleProjectContextMenu,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleProjectTitlePointerDownCapture,
    handleProjectTitleClick,
    handleProjectTitleKeyDown,
  };
}
