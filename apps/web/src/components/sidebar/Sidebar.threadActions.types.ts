import type { MouseEvent } from "react";
import { type ProjectId, type ThreadId } from "@bigbud/contracts";
import type { useSettings } from "../../hooks/useSettings";
import type { SidebarThreadSummary } from "../../models/types";

export interface SidebarThreadActionsInput {
  sidebarThreadsById: Record<ThreadId, SidebarThreadSummary | undefined>;
  projectCwdById: Map<ProjectId, string | null>;
  appSettings: ReturnType<typeof useSettings>;
  /** Navigates to a thread route and clears multi-selection. */
  navigateToThreadRoute: (threadId: ThreadId) => void;
  /** Called when a thread rename starts — cancels any in-progress project rename. */
  cancelProjectRename: () => void;
}

export interface SidebarThreadActionsOutput {
  // Rename state
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
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  forkThread: (threadId: ThreadId) => Promise<void>;
  toggleFavoriteThread: (threadId: ThreadId) => Promise<void>;
  pendingDeleteConfirmation: {
    title: string;
    description: string;
    threadIds: readonly ThreadId[];
  } | null;
  dismissPendingDeleteConfirmation: () => void;
  confirmPendingDeleteThreads: () => Promise<void>;
  requestThreadDelete: (threadId: ThreadId) => Promise<void>;
  // Selection
  selectedThreadIds: ReadonlySet<ThreadId>;
  clearSelection: () => void;
  // Handlers
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
}
