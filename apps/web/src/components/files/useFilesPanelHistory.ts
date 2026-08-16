import { useCallback, useEffect, useRef, type RefObject } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { canMoveFileHistory } from "../../stores/files/filesPanel.history";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { notifyRemovedFileHistoryEntries } from "./FilesPanel.historyNotification";

interface FilesPanelHistoryInput {
  readonly workspaceKey: string;
  readonly workspaceRoot: string | null;
  readonly workspaceExecutionTargetId?: string | undefined;
}

type FileExistence = "exists" | "missing" | "unknown";

export function useFilesPanelAuxNavigation(
  panelRef: RefObject<HTMLElement | null>,
  canNavigate: (direction: -1 | 1) => boolean,
  navigate: (direction: -1 | 1) => void,
) {
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      const direction = filesPanelNavigationDirection(event.button);
      if (direction === null) return;
      event.preventDefault();
      if (canNavigate(direction)) navigate(direction);
    };
    const panel = panelRef.current;
    panel?.addEventListener("mousedown", handleMouseDown);
    return () => panel?.removeEventListener("mousedown", handleMouseDown);
  }, [canNavigate, navigate, panelRef]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;

    const unsubscribe = onMenuAction((action) => {
      const direction = filesPanelAppCommandDirection(action);
      if (direction === null || panelRef.current?.closest("[inert]")) return;
      if (canNavigate(direction)) navigate(direction);
    });
    return () => unsubscribe?.();
  }, [canNavigate, navigate, panelRef]);
}

export function filesPanelNavigationDirection(button: number): -1 | 1 | null {
  if (button === 3) return -1;
  if (button === 4) return 1;
  return null;
}

export function filesPanelAppCommandDirection(action: string): -1 | 1 | null {
  if (action === "browser-backward") return -1;
  if (action === "browser-forward") return 1;
  return null;
}

export function useFilesPanelScrollPersistence(workspaceKey: string, path: string | null) {
  const timeoutRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    const scrollTop = pendingScrollTopRef.current;
    pendingScrollTopRef.current = null;
    const state = useFilesPanelStore.getState();
    if (path && scrollTop !== null && state.workspaceKey === workspaceKey) {
      state.updateHistoryEntry(path, { scrollTop });
    }
  }, [path, workspaceKey]);

  useEffect(() => flush, [flush]);

  return useCallback(
    (scrollTop: number) => {
      pendingScrollTopRef.current = scrollTop;
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(flush, 150);
    },
    [flush],
  );
}

function parentDirectory(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex < 0 ? "" : path.slice(0, separatorIndex);
}

export function isConfirmedMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:ENOENT|ENOTDIR)\b|no such file or directory/i.test(message);
}

async function checkFileExists(
  workspaceRoot: string,
  relativePath: string,
  workspaceExecutionTargetId: string | undefined,
): Promise<FileExistence> {
  const api = readNativeApi();
  if (!api) return "unknown";

  try {
    const directory = await api.projects.listDirectory({
      cwd: workspaceRoot,
      ...(workspaceExecutionTargetId ? { executionTargetId: workspaceExecutionTargetId } : {}),
      ...(parentDirectory(relativePath) ? { relativePath: parentDirectory(relativePath) } : {}),
    });
    return directory.entries.some((entry) => entry.path === relativePath) ? "exists" : "missing";
  } catch (error) {
    return isConfirmedMissingFileError(error) ? "missing" : "unknown";
  }
}

export function useFilesPanelHistory({
  workspaceKey,
  workspaceRoot,
  workspaceExecutionTargetId,
}: FilesPanelHistoryInput) {
  const restoreCurrentPreview = useCallback(async () => {
    if (!workspaceRoot) return;
    const state = useFilesPanelStore.getState();
    if (state.workspaceKey !== workspaceKey || state.previewPath !== null) return;
    const history = state.histories[workspaceKey];
    const entry = history?.entries[history.index];
    if (!entry) return;

    const existence = await checkFileExists(workspaceRoot, entry.path, workspaceExecutionTargetId);
    const current = useFilesPanelStore.getState();
    if (current.workspaceKey !== workspaceKey || current.previewPath !== null) return;
    const currentHistory = current.histories[workspaceKey];
    if (currentHistory?.entries[currentHistory.index]?.path !== entry.path) return;
    if (existence === "missing") {
      notifyRemovedFileHistoryEntries(current.removeHistoryPaths(workspaceKey, [entry.path]));
    } else current.showCurrentPreview();
  }, [workspaceExecutionTargetId, workspaceKey, workspaceRoot]);

  const navigateHistory = useCallback(
    async (direction: -1 | 1) => {
      if (!workspaceRoot) return;
      let removedCount = 0;
      while (true) {
        const state = useFilesPanelStore.getState();
        if (state.workspaceKey !== workspaceKey) return;
        const history = state.histories[workspaceKey];
        if (!history || !canMoveFileHistory(history, direction)) {
          notifyRemovedFileHistoryEntries(removedCount);
          return;
        }
        const entry = history.entries[history.index + direction];
        if (!entry) return;

        const existence = await checkFileExists(
          workspaceRoot,
          entry.path,
          workspaceExecutionTargetId,
        );
        const current = useFilesPanelStore.getState();
        if (current.workspaceKey !== workspaceKey) return;
        const currentHistory = current.histories[workspaceKey];
        if (
          currentHistory?.index !== history.index ||
          currentHistory.entries[currentHistory.index + direction]?.path !== entry.path
        ) {
          return;
        }
        if (existence === "missing") {
          removedCount += current.removeHistoryPaths(workspaceKey, [entry.path]);
          continue;
        }
        current.moveHistory(direction);
        notifyRemovedFileHistoryEntries(removedCount);
        return;
      }
    },
    [workspaceExecutionTargetId, workspaceKey, workspaceRoot],
  );

  const removePreviewIfMissing = useCallback(
    async (path: string, error?: unknown) => {
      if (!workspaceRoot) return;
      if (error !== undefined && !isConfirmedMissingFileError(error)) return;
      const existence = await checkFileExists(workspaceRoot, path, workspaceExecutionTargetId);
      const state = useFilesPanelStore.getState();
      if (state.workspaceKey === workspaceKey && existence === "missing") {
        notifyRemovedFileHistoryEntries(state.removeHistoryPaths(workspaceKey, [path]));
      }
    },
    [workspaceExecutionTargetId, workspaceKey, workspaceRoot],
  );

  return { navigateHistory, removePreviewIfMissing, restoreCurrentPreview };
}
