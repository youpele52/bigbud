import { type ThreadId } from "@bigbud/contracts";
import { type MouseEvent, type ReactNode } from "react";

import { type ThreadPr } from "./SidebarThreadRow.status";

export type SidebarProjectSnapshot = {
  expanded: boolean;
};

export interface SidebarThreadRowProps {
  threadId: ThreadId;
  orderedProjectThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  showThreadJumpHints: boolean;
  jumpLabel: string | null;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  onRenamingInputMount: (element: HTMLInputElement | null) => void;
  hasRenameCommitted: () => boolean;
  markRenameCommitted: () => void;
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
  favoriteThreadIds: ReadonlySet<ThreadId>;
  toggleFavoriteThread: (threadId: ThreadId) => Promise<void>;
  requestThreadDelete: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  pr: ThreadPr | null;
  automationThreadIds?: ReadonlySet<ThreadId>;
  hiddenThreadStatusSlot?: ReactNode;
}
