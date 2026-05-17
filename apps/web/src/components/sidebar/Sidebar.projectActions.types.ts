import { type DragCancelEvent, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { type ProjectId, type ThreadId as ThreadIdType } from "@bigbud/contracts";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { type useSettings } from "../../hooks/useSettings";
import type { Project } from "../../models/types";
import type { SidebarProjectSnapshot } from "./Sidebar.types";

export interface SidebarProjectActionsInput {
  projects: Project[];
  threadIdsByProjectId: Record<string, ThreadIdType[]>;
  sidebarProjects: SidebarProjectSnapshot[];
  appSettings: ReturnType<typeof useSettings>;
  dragInProgressRef: { current: boolean };
  suppressProjectClickAfterDragRef: { current: boolean };
  suppressProjectClickForContextMenuRef: { current: boolean };
  selectedThreadIdsSize: number;
  clearSelection: () => void;
  copyPathToClipboard: (text: string, ctx: { path: string }) => void;
  cancelThreadRename: () => void;
}

export interface SidebarProjectActionsOutput {
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
