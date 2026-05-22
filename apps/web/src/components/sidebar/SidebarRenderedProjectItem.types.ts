import { isBuiltInChatsProject, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

import { resolveThreadStatusPill, type SidebarNewThreadEnvMode } from "./Sidebar.logic";
import type { SortableProjectHandleProps } from "./SidebarProjectItem";
import { type ThreadPr } from "./SidebarThreadRow";

type ProjectStatusIndicator = NonNullable<ReturnType<typeof resolveThreadStatusPill>>;

export interface RenderedProjectData {
  hasHiddenThreads: boolean;
  hiddenThreadStatus: ProjectStatusIndicator | null;
  orderedProjectThreadIds: readonly ThreadId[];
  project: {
    id: ProjectId;
    name: string;
    cwd: string;
    executionTargetId?: string | undefined;
    expanded: boolean;
  };
  projectStatus: ProjectStatusIndicator | null;
  renderedThreadIds: readonly ThreadId[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
}

export interface SidebarRenderedProjectItemProps extends RenderedProjectData {
  dragHandleProps: SortableProjectHandleProps | null;
  isManualProjectSorting: boolean;
  newThreadShortcutLabel: string | null | undefined;
  showThreadJumpHints: boolean;
  threadJumpLabelById: Map<ThreadId, string>;
  appSettingsDefaultThreadEnvMode: SidebarNewThreadEnvMode;
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  onRenamingInputMount: (element: HTMLInputElement | null) => void;
  hasRenameCommitted: () => boolean;
  markRenameCommitted: () => void;
  favoriteThreadIds: ReadonlySet<ThreadId>;
  toggleFavoriteThread: (threadId: ThreadId) => Promise<void>;
  activeThread: {
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread: {
    projectId: ProjectId;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
  } | null;
  renamingProjectId: ProjectId | null;
  renamingProjectTitle: string;
  setRenamingProjectTitle: (title: string) => void;
  onProjectRenamingInputMount: (element: HTMLInputElement | null) => void;
  hasProjectRenameCommitted: () => boolean;
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
  branchThread: (threadId: ThreadId) => Promise<void>;
  requestThreadDelete: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  prByThreadId: Map<ThreadId, ThreadPr>;
  handleNewThread: (
    projectId: ProjectId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: SidebarNewThreadEnvMode;
    },
  ) => Promise<void>;
  expandThreadListForProject: (projectId: ProjectId) => void;
  collapseThreadListForProject: (projectId: ProjectId) => void;
}

export function isChatsSidebarProject(projectId: ProjectId) {
  return isBuiltInChatsProject(projectId);
}
