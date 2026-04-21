import {
  useCallback,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
  type KeyboardEvent,
} from "react";
import type React from "react";
import { type DragCancelEvent, type DragStartEvent, type DragEndEvent } from "@dnd-kit/core";
import {
  isBuiltInChatsProject,
  ThreadId,
  type ProjectId,
  type ThreadId as ThreadIdType,
} from "@bigbud/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import { isMacPlatform, newCommandId, newProjectId } from "../../lib/utils";
import { useUiStateStore } from "../../stores/ui";
import { useComposerDraftStore } from "../../stores/composer";
import { useThreadSelectionStore } from "../../stores/thread";
import { useTerminalStateStore } from "../../stores/terminal";
import { useStore } from "../../stores/main";
import { readNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSettings } from "../../hooks/useSettings";
import { getFallbackThreadIdAfterDelete, isContextMenuPointerDown } from "./Sidebar.logic";
import type { Project } from "../../models/types";
import type { SidebarProjectSnapshot } from "./Sidebar.types";
import { useServerProviders } from "../../rpc/serverState";
import { getDefaultModelSelection } from "../../models/provider/provider.models";

export interface SidebarProjectActionsInput {
  /** Projects list from the main store. */
  projects: Project[];
  threadIdsByProjectId: Record<string, ThreadIdType[]>;
  sidebarProjects: SidebarProjectSnapshot[];
  appSettings: ReturnType<typeof useSettings>;
  isAddingProject: boolean;
  setIsAddingProject: (v: boolean) => void;
  newCwd: string;
  setNewCwd: (v: string) => void;
  setAddProjectError: (v: string | null) => void;
  setAddingProject: (updater: (prev: boolean) => boolean) => void;
  isPickingFolder: boolean;
  setIsPickingFolder: (v: boolean) => void;
  addProjectInputRef: React.MutableRefObject<HTMLInputElement | null>;
  shouldBrowseForProjectImmediately: boolean;
  /** Shared drag refs — owned by the composition hook. */
  dragInProgressRef: React.MutableRefObject<boolean>;
  suppressProjectClickAfterDragRef: React.MutableRefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.MutableRefObject<boolean>;
  selectedThreadIdsSize: number;
  clearSelection: () => void;
  copyPathToClipboard: (text: string, ctx: { path: string }) => void;
  focusMostRecentThreadForProject: (projectId: ProjectId) => void;
  handleNewThread: ReturnType<typeof useHandleNewThread>["handleNewThread"];
  /** Called when a thread rename is in progress — cancels it so both can't be active at once. */
  cancelThreadRename: () => void;
}

export interface SidebarProjectActionsOutput {
  // Project rename
  renamingProjectId: ProjectId | null;
  renamingProjectTitle: string;
  setRenamingProjectTitle: (title: string) => void;
  /** Callback ref for the rename input element — handles focus/select on mount. */
  onProjectRenamingInputMount: (element: HTMLInputElement | null) => void;
  /** Returns whether the project rename has already been committed. */
  hasProjectRenameCommitted: () => boolean;
  /** Marks the project rename as committed to prevent double-commit on blur. */
  markProjectRenameCommitted: () => void;
  commitProjectRename: (
    projectId: ProjectId,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelProjectRename: () => void;
  pendingProjectDeleteConfirmation: {
    projectId: ProjectId;
    projectName: string;
    threadCount: number;
  } | null;
  dismissPendingProjectDeleteConfirmation: () => void;
  confirmPendingProjectDelete: () => Promise<void>;
  requestProjectDelete: (projectId: ProjectId) => void;
  // Other actions
  addProjectFromPath: (rawCwd: string) => Promise<void>;
  handleAddProject: () => void;
  handlePickFolder: () => Promise<void>;
  handleStartAddProject: () => void;
  cancelAddProject: () => void;
  handleProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleProjectTitlePointerDownCapture: (event: PointerEvent<HTMLButtonElement>) => void;
  handleProjectTitleClick: (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  handleProjectTitleKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
}

/** Encapsulates all project-level actions for the sidebar. */
export function useSidebarProjectActions({
  projects,
  threadIdsByProjectId,
  sidebarProjects,
  appSettings,
  isAddingProject,
  setIsAddingProject,
  newCwd,
  setNewCwd,
  setAddProjectError,
  setAddingProject,
  isPickingFolder,
  setIsPickingFolder,
  addProjectInputRef,
  shouldBrowseForProjectImmediately,
  dragInProgressRef,
  suppressProjectClickAfterDragRef,
  suppressProjectClickForContextMenuRef,
  selectedThreadIdsSize,
  clearSelection,
  copyPathToClipboard,
  focusMostRecentThreadForProject,
  handleNewThread,
  cancelThreadRename,
}: SidebarProjectActionsInput): SidebarProjectActionsOutput {
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const clearTerminalState = useTerminalStateStore((store) => store.clearTerminalState);
  const removeFromSelection = useThreadSelectionStore((store) => store.removeFromSelection);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const navigate = useNavigate();
  const serverProviders = useServerProviders();

  const [renamingProjectId, setRenamingProjectId] = useState<ProjectId | null>(null);
  const [renamingProjectTitle, setRenamingProjectTitle] = useState("");
  const [pendingProjectDeleteConfirmation, setPendingProjectDeleteConfirmation] = useState<{
    projectId: ProjectId;
    projectName: string;
    threadCount: number;
  } | null>(null);
  const projectRenamingCommittedRef = useRef(false);
  const projectRenamingInputRef = useRef<HTMLInputElement | null>(null);

  const cancelProjectRename = useCallback(() => {
    setRenamingProjectId(null);
    projectRenamingInputRef.current = null;
  }, []);

  const onProjectRenamingInputMount = useCallback((element: HTMLInputElement | null) => {
    if (element && projectRenamingInputRef.current !== element) {
      projectRenamingInputRef.current = element;
      element.focus();
      element.select();
      return;
    }
    if (element === null && projectRenamingInputRef.current !== null) {
      projectRenamingInputRef.current = null;
    }
  }, []);

  const hasProjectRenameCommitted = useCallback(() => projectRenamingCommittedRef.current, []);

  const markProjectRenameCommitted = useCallback(() => {
    projectRenamingCommittedRef.current = true;
  }, []);

  const commitProjectRename = useCallback(
    async (projectId: ProjectId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingProjectId((current) => {
          if (current !== projectId) return current;
          projectRenamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Project title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

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

      for (const thread of projectThreads) {
        if (thread.session && thread.session.status !== "closed") {
          await api.orchestration
            .dispatchCommand({
              type: "thread.session.stop",
              commandId: newCommandId(),
              threadId: thread.id,
              createdAt: new Date().toISOString(),
            })
            .catch(() => undefined);
        }

        try {
          await api.terminal.close({ threadId: thread.id, deleteHistory: true });
        } catch {
          // Terminal may already be closed.
        }
      }

      const projectDraftThread = getDraftThreadByProjectId(projectId);

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

      for (const thread of projectThreads) {
        clearComposerDraftForThread(thread.id);
        clearProjectDraftThreadById(thread.projectId, thread.id);
        clearTerminalState(thread.id);
      }
      if (projectDraftThread) {
        clearComposerDraftForThread(projectDraftThread.threadId);
      }
      clearProjectDraftThreadId(projectId);
      removeFromSelection(projectThreads.map((thread) => thread.id));

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
    clearComposerDraftForThread,
    clearProjectDraftThreadById,
    clearProjectDraftThreadId,
    clearTerminalState,
    getDraftThreadByProjectId,
    appSettings.sidebarThreadSortOrder,
    navigate,
    pendingProjectDeleteConfirmation,
    removeFromSelection,
    routeThreadId,
    threadIdsByProjectId,
  ]);

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(() => false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModelSelection: getDefaultModelSelection(serverProviders),
          createdAt,
        });
        await handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch(() => undefined);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      serverProviders,
      shouldBrowseForProjectImmediately,
      appSettings.defaultThreadEnvMode,
      setIsAddingProject,
      setNewCwd,
      setAddProjectError,
      setAddingProject,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const handlePickFolder = useCallback(async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  }, [
    addProjectFromPath,
    isPickingFolder,
    shouldBrowseForProjectImmediately,
    setIsPickingFolder,
    addProjectInputRef,
  ]);

  const handleStartAddProject = useCallback(() => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  }, [handlePickFolder, setAddProjectError, setAddingProject, shouldBrowseForProjectImmediately]);

  const cancelAddProject = useCallback(() => {
    setAddingProject(() => false);
    setAddProjectError(null);
  }, [setAddingProject, setAddProjectError]);

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
    [cancelThreadRename, copyPathToClipboard, projects, requestProjectDelete],
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
      toggleProject(projectId);
    },
    [
      clearSelection,
      dragInProgressRef,
      selectedThreadIdsSize,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
      toggleProject,
    ],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [dragInProgressRef, toggleProject],
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
    addProjectFromPath,
    handleAddProject,
    handlePickFolder,
    handleStartAddProject,
    cancelAddProject,
    handleProjectContextMenu,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleProjectTitlePointerDownCapture,
    handleProjectTitleClick,
    handleProjectTitleKeyDown,
  };
}
