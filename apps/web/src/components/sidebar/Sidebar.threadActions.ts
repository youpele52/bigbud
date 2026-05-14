import { useCallback, useRef, useState, type MouseEvent } from "react";
import { FAVORITE_THREAD_LIMIT, type ThreadId, type ProjectId } from "@bigbud/contracts";
import { isMacPlatform, newCommandId } from "../../lib/utils";
import { useUiStateStore } from "../../stores/ui";
import { useThreadSelectionStore } from "../../stores/thread";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useSidebar } from "../ui/sidebar";
import { readNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
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

/** Encapsulates all thread-level actions for the sidebar. */
export function useSidebarThreadActions({
  sidebarThreadsById,
  projectCwdById,
  appSettings,
  navigateToThreadRoute,
  cancelProjectRename,
}: SidebarThreadActionsInput): SidebarThreadActionsOutput {
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);
  const { updateSettings } = useUpdateSettings();
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const { archiveThread, deleteThread, forkThread } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [pendingDeleteConfirmation, setPendingDeleteConfirmation] = useState<{
    title: string;
    description: string;
    threadIds: readonly ThreadId[];
  } | null>(null);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const onRenamingInputMount = useCallback((element: HTMLInputElement | null) => {
    if (element && renamingInputRef.current !== element) {
      renamingInputRef.current = element;
      element.focus();
      element.select();
      return;
    }
    if (element === null && renamingInputRef.current !== null) {
      renamingInputRef.current = null;
    }
  }, []);

  const hasRenameCommitted = useCallback(() => renamingCommittedRef.current, []);

  const markRenameCommitted = useCallback(() => {
    renamingCommittedRef.current = true;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
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
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const attemptArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await archiveThread(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [archiveThread],
  );

  const toggleFavoriteThread = useCallback(
    async (threadId: ThreadId) => {
      const favoriteThreadIds = appSettings.favoriteThreadIds;
      if (favoriteThreadIds.includes(threadId)) {
        updateSettings({
          favoriteThreadIds: favoriteThreadIds.filter((favoriteId) => favoriteId !== threadId),
        });
        return;
      }

      if (favoriteThreadIds.length >= FAVORITE_THREAD_LIMIT) {
        toastManager.add({
          type: "warning",
          title: "Pinned limit reached",
          description: `You can pin up to ${FAVORITE_THREAD_LIMIT} threads.`,
        });
        return;
      }

      updateSettings({
        favoriteThreadIds: [threadId, ...favoriteThreadIds],
      });
    },
    [appSettings.favoriteThreadIds, updateSettings],
  );

  const handleForkThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await forkThread(threadId, { navigateToFork: true });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to fork thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [forkThread],
  );

  const openPrLink = useCallback((event: MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const dismissPendingDeleteConfirmation = useCallback(() => {
    setPendingDeleteConfirmation(null);
  }, []);

  const requestThreadDelete = useCallback(
    async (threadId: ThreadId) => {
      const thread = sidebarThreadsById[threadId];
      if (!thread) {
        return;
      }

      if (appSettings.confirmThreadDelete) {
        setPendingDeleteConfirmation({
          title: `Delete thread "${thread.title}"?`,
          description: "This permanently clears conversation history for this thread.",
          threadIds: [threadId],
        });
        return;
      }

      await deleteThread(threadId);
    },
    [appSettings.confirmThreadDelete, deleteThread, sidebarThreadsById],
  );

  const confirmPendingDeleteThreads = useCallback(async () => {
    if (!pendingDeleteConfirmation) {
      return;
    }

    const ids = [...pendingDeleteConfirmation.threadIds];
    setPendingDeleteConfirmation(null);

    if (ids.length === 1) {
      await deleteThread(ids[0]!);
      return;
    }

    const deletedIds = new Set<ThreadId>(ids);
    for (const id of ids) {
      await deleteThread(id, { deletedThreadIds: deletedIds });
    }
    removeFromSelection(ids);
  }, [deleteThread, pendingDeleteConfirmation, removeFromSelection]);

  const navigateToThread = useCallback(
    (threadId: ThreadId) => {
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      closeMobileSidebar();
      navigateToThreadRoute(threadId);
    },
    [
      clearSelection,
      closeMobileSidebar,
      navigateToThreadRoute,
      selectedThreadIds.size,
      setSelectionAnchor,
    ],
  );

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      closeMobileSidebar();
      navigateToThreadRoute(threadId);
    },
    [
      clearSelection,
      closeMobileSidebar,
      navigateToThreadRoute,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = sidebarThreadsById[threadId];
      if (!thread) return;
      const threadWorkspacePath =
        thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
      const isFavorite = appSettings.favoriteThreadIds.includes(threadId);
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "fork", label: "Fork thread" },
          {
            id: "favorite",
            label: isFavorite ? "Unpin thread" : "Pin thread",
          },
          { id: "archive", label: "Archive thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        cancelProjectRename();
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "fork") {
        await handleForkThread(threadId);
        return;
      }

      if (clicked === "favorite") {
        await toggleFavoriteThread(threadId);
        return;
      }

      if (clicked === "archive") {
        const shouldArchive =
          !appSettings.confirmThreadArchive ||
          (await api.dialogs.confirm(`Archive thread "${thread.title}"?`));
        if (!shouldArchive) {
          return;
        }
        await attemptArchiveThread(threadId);
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId, { threadId });
        return;
      }
      if (clicked !== "delete") return;
      await requestThreadDelete(threadId);
    },
    [
      cancelProjectRename,
      appSettings.favoriteThreadIds,
      appSettings.confirmThreadArchive,
      attemptArchiveThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      handleForkThread,
      markThreadUnread,
      projectCwdById,
      requestThreadDelete,
      sidebarThreadsById,
      toggleFavoriteThread,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          const thread = sidebarThreadsById[id];
          markThreadUnread(id, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        setPendingDeleteConfirmation({
          title: `Delete ${count} thread${count === 1 ? "" : "s"}?`,
          description: "This permanently clears conversation history for these threads.",
          threadIds: ids,
        });
        return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
      sidebarThreadsById,
    ],
  );

  return {
    renamingThreadId,
    renamingTitle,
    setRenamingTitle,
    onRenamingInputMount,
    hasRenameCommitted,
    markRenameCommitted,
    cancelRename,
    commitRename,
    attemptArchiveThread,
    forkThread: handleForkThread,
    toggleFavoriteThread,
    pendingDeleteConfirmation,
    dismissPendingDeleteConfirmation,
    confirmPendingDeleteThreads,
    requestThreadDelete,
    selectedThreadIds,
    clearSelection,
    handleThreadClick,
    navigateToThread,
    handleThreadContextMenu,
    handleMultiSelectContextMenu,
    openPrLink,
  };
}
