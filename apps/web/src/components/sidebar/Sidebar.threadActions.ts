import { useCallback, type MouseEvent } from "react";
import { FAVORITE_THREAD_LIMIT, type ThreadId } from "@bigbud/contracts";
import { isMacPlatform } from "../../lib/utils";
import { useThreadSelectionStore } from "../../stores/thread";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useUpdateSettings } from "../../hooks/useSettings";
import { useSidebar } from "../ui/sidebar";
import { readNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";
import { useSidebarThreadDeleteActions } from "./Sidebar.threadActions.delete";
import { useSidebarThreadClipboardActions } from "./Sidebar.threadActions.clipboard";
import { useSidebarThreadRenameActions } from "./Sidebar.threadActions.rename";
import type {
  SidebarThreadActionsInput,
  SidebarThreadActionsOutput,
} from "./Sidebar.threadActions.types";

function normalizeSummaryText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

/** Encapsulates all thread-level actions for the sidebar. */
export function useSidebarThreadActions({
  sidebarThreadsById,
  projectCwdById: _projectCwdById,
  appSettings,
  navigateToThreadRoute,
  cancelProjectRename,
}: SidebarThreadActionsInput): SidebarThreadActionsOutput {
  const { updateSettings } = useUpdateSettings();
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const { archiveThread, deleteThread, branchThread } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  const {
    renamingThreadId,
    setRenamingThreadId,
    renamingTitle,
    setRenamingTitle,
    renamingCommittedRef,
    cancelRename,
    onRenamingInputMount,
    hasRenameCommitted,
    markRenameCommitted,
    commitRename,
  } = useSidebarThreadRenameActions();
  const {
    pendingDeleteConfirmation,
    setPendingDeleteConfirmation,
    dismissPendingDeleteConfirmation,
    requestThreadDelete,
    confirmPendingDeleteThreads,
  } = useSidebarThreadDeleteActions({
    confirmThreadDelete: appSettings.confirmThreadDelete,
    sidebarThreadsById,
    deleteThread,
    removeFromSelection,
  });

  const { copyElevatorSummaryToClipboard, copyThreadIdToClipboard, copyPathToClipboard } =
    useSidebarThreadClipboardActions();

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

  const handleBranchThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await branchThread(threadId, { navigateToBranch: true });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to branch thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [branchThread],
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
      navigateToThread(threadId);
    },
    [
      clearSelection,
      closeMobileSidebar,
      navigateToThread,
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
      const isFavorite = appSettings.favoriteThreadIds.includes(threadId);
      const normalizedTitle = normalizeSummaryText(thread.title);
      const normalizedElevatorSummary = normalizeSummaryText(thread.elevatorSummary);
      const hasElevatorSummary =
        normalizedElevatorSummary.length > 0 && normalizedElevatorSummary !== normalizedTitle;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "branch", label: "Branch thread" },
          {
            id: "favorite",
            label: isFavorite ? "Unpin thread" : "Pin thread",
          },
          { id: "archive", label: "Archive thread" },
          {
            id: "copy-elevator-summary",
            label: "Elevator summary",
            disabled: !hasElevatorSummary,
          },
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

      if (clicked === "branch") {
        await handleBranchThread(threadId);
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

      if (clicked === "copy-elevator-summary") {
        copyElevatorSummaryToClipboard(normalizedElevatorSummary, {
          summary: normalizedElevatorSummary,
        });
        return;
      }
      if (clicked === "copy-path") {
        try {
          const { path } = await api.server.exportThreadContext({ threadId });
          copyPathToClipboard(path, { path });
        } catch {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "Failed to export thread context path.",
          });
        }
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
      copyElevatorSummaryToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      handleBranchThread,
      requestThreadDelete,
      renamingCommittedRef,
      setRenamingThreadId,
      setRenamingTitle,
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
        [{ id: "delete", label: `Delete (${count})`, destructive: true }],
        position,
      );

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
      deleteThread,
      removeFromSelection,
      selectedThreadIds,
      setPendingDeleteConfirmation,
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
    branchThread: handleBranchThread,
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
