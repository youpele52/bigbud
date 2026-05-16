import {
  useCallback,
  useRef,
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
import { readNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";
import { useSettings } from "../../hooks/useSettings";
import { getFallbackThreadIdAfterDelete, isContextMenuPointerDown } from "./Sidebar.logic";
import type { Project } from "../../models/types";
import type { SidebarProjectSnapshot } from "./Sidebar.types";

export interface SidebarProjectActionsInput {
  /** Projects list from the main store. */
  projects: Project[];
  threadIdsByProjectId: Record<string, ThreadIdType[]>;
  sidebarProjects: SidebarProjectSnapshot[];
  appSettings: ReturnType<typeof useSettings>;
  /** Shared drag refs — owned by the composition hook. */
  dragInProgressRef: { current: boolean };
  suppressProjectClickAfterDragRef: { current: boolean };
  suppressProjectClickForContextMenuRef: { current: boolean };
  selectedThreadIdsSize: number;
  clearSelection: () => void;
  copyPathToClipboard: (text: string, ctx: { path: string }) => void;
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
  dragInProgressRef,
  suppressProjectClickAfterDragRef,
  suppressProjectClickForContextMenuRef,
  selectedThreadIdsSize,
  clearSelection,
  copyPathToClipboard,
  cancelThreadRename,
}: SidebarProjectActionsInput): SidebarProjectActionsOutput {
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const navigate = useNavigate();

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
    handleProjectContextMenu,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleProjectTitlePointerDownCapture,
    handleProjectTitleClick,
    handleProjectTitleKeyDown,
  };
}
