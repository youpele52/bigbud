import type React from "react";
import type { MouseEvent, KeyboardEvent, PointerEvent } from "react";
import type { DragCancelEvent, DragStartEvent, DragEndEvent } from "@dnd-kit/core";
import type { ProjectId, ThreadId } from "@bigbud/contracts";
import type { useStore } from "../../stores/main";
import type { useDesktopUpdateState } from "../../hooks/useDesktopUpdateState";
import type { useHandleNewThread } from "../../hooks/useHandleNewThread";
import type { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import type { resolveThreadStatusPill } from "./Sidebar.logic";
import type { ThreadPr } from "./SidebarThreadRow";
import type { Project } from "../../models/types";

export type SidebarProjectSnapshot = Project & {
  expanded: boolean;
};

export interface RenderedProjectEntry {
  hasHiddenThreads: boolean;
  hiddenThreadStatus: ReturnType<typeof resolveThreadStatusPill>;
  orderedProjectThreadIds: readonly ThreadId[];
  project: SidebarProjectSnapshot;
  projectStatus: ReturnType<typeof resolveThreadStatusPill>;
  renderedThreadIds: readonly ThreadId[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
}

/** All props that are passed to each rendered project item. */
export interface SharedProjectItemProps {
  isManualProjectSorting: boolean;
  newThreadShortcutLabel: string | null | undefined;
  showThreadJumpHints: boolean;
  threadJumpLabelById: Map<ThreadId, string>;
  appSettingsConfirmThreadArchive: boolean;
  appSettingsDefaultThreadEnvMode: "local" | "worktree";
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  /** Callback ref for the rename input element — handles focus/select on mount. */
  onRenamingInputMount: (element: HTMLInputElement | null) => void;
  /** Returns whether the rename has already been committed. */
  hasRenameCommitted: () => boolean;
  /** Marks the rename as committed to prevent double-commit on blur. */
  markRenameCommitted: () => void;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: React.Dispatch<React.SetStateAction<ThreadId | null>>;
  confirmArchiveButtonRefs: React.MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
  activeThread: { projectId: ProjectId; branch: string | null; worktreePath: string | null } | null;
  activeDraftThread: {
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
    envMode: "local" | "worktree";
  } | null;
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
  requestProjectDelete: (projectId: ProjectId) => void;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleProjectTitlePointerDownCapture: (event: PointerEvent<HTMLButtonElement>) => void;
  handleProjectTitleClick: (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  handleProjectTitleKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  handleProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  requestThreadDelete: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  prByThreadId: Map<ThreadId, ThreadPr>;
  handleNewThread: ReturnType<typeof useHandleNewThread>["handleNewThread"];
  expandThreadListForProject: (projectId: ProjectId) => void;
  collapseThreadListForProject: (projectId: ProjectId) => void;
}

export interface SidebarRenderedThreadEntry {
  threadId: ThreadId;
  orderedThreadIds: readonly ThreadId[];
}

/** All state and callbacks returned by `useSidebarState`. */
export interface SidebarState {
  // Data
  projects: ReturnType<typeof useStore<Project[]>>;
  bootstrapComplete: boolean;
  chatsProject: Project | null;
  renderedChats: SidebarRenderedThreadEntry[];
  renderedProjects: RenderedProjectEntry[];
  isManualProjectSorting: boolean;
  isOnSettings: boolean;
  pathname: string;
  prByThreadId: Map<ThreadId, ThreadPr>;
  appSettings: ReturnType<typeof useSettings>;
  // Update state
  desktopUpdateState: ReturnType<typeof useDesktopUpdateState>["desktopUpdateState"];
  desktopUpdateButtonDisabled: boolean;
  desktopUpdateButtonAction: ReturnType<typeof useDesktopUpdateState>["desktopUpdateButtonAction"];
  handleDesktopUpdateButtonClick: () => void;
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  // New project flow
  addingProject: boolean;
  newCwd: string;
  isPickingFolder: boolean;
  isAddingProject: boolean;
  addProjectError: string | null;
  addProjectInputRef: React.RefObject<HTMLInputElement | null>;
  shouldShowProjectPathEntry: boolean;
  setNewCwd: (cwd: string) => void;
  setAddProjectError: (error: string | null) => void;
  handleStartAddProject: () => void;
  handleAddProject: () => void;
  handlePickFolder: () => Promise<void>;
  /** Cancel the add-project flow, resetting both the form and the visibility flag. */
  cancelAddProject: () => void;
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
  // Thread rename
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  /** Callback ref for the rename input element — handles focus/select on mount. */
  onRenamingInputMount: (element: HTMLInputElement | null) => void;
  /** Returns whether the rename has already been committed. */
  hasRenameCommitted: () => boolean;
  /** Marks the rename as committed to prevent double-commit on blur. */
  markRenameCommitted: () => void;
  cancelRename: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  // Thread archive confirm
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: React.Dispatch<React.SetStateAction<ThreadId | null>>;
  confirmArchiveButtonRefs: React.MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  pendingDeleteConfirmation: {
    title: string;
    description: string;
    threadIds: readonly ThreadId[];
  } | null;
  dismissPendingDeleteConfirmation: () => void;
  confirmPendingDeleteThreads: () => Promise<void>;
  requestThreadDelete: (threadId: ThreadId) => Promise<void>;
  pendingProjectDeleteConfirmation: {
    projectId: ProjectId;
    projectName: string;
    threadCount: number;
  } | null;
  dismissPendingProjectDeleteConfirmation: () => void;
  confirmPendingProjectDelete: () => Promise<void>;
  requestProjectDelete: (projectId: ProjectId) => void;
  // Thread selection
  selectedThreadIds: ReadonlySet<ThreadId>;
  clearSelection: () => void;
  // Project drag
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  // Project title interaction
  handleProjectTitlePointerDownCapture: (event: PointerEvent<HTMLButtonElement>) => void;
  handleProjectTitleClick: (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  handleProjectTitleKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  handleProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  // Thread interaction
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  handleNewChat: () => Promise<void>;
  handleNewThread: ReturnType<typeof useHandleNewThread>["handleNewThread"];
  // Thread list expand/collapse
  expandThreadListForProject: (projectId: ProjectId) => void;
  collapseThreadListForProject: (projectId: ProjectId) => void;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  // Shared props bundle
  sharedProjectItemProps: SharedProjectItemProps;
  // Settings
  updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"];
  newThreadShortcutLabel: string | null | undefined;
  showThreadJumpHints: boolean;
  threadJumpLabelById: Map<ThreadId, string>;
}
