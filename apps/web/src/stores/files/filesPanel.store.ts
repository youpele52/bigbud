import type { PathPosition } from "../../models/editor";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createDebouncedStorage, resolveStorage } from "../../lib/storage";
import {
  emptyFileHistory,
  FILE_HISTORY_WORKSPACE_LIMIT,
  moveFileHistory,
  normalizeFileHistory,
  openFileInHistory,
  removeFileFromHistory,
  updateCurrentFileHistoryEntry,
  type FileHistory,
  type FileHistoryEntry,
} from "./filesPanel.history";

const FILE_HISTORY_STORAGE_KEY = "bigbud:file-history:v1";
const fileHistoryStorage = createDebouncedStorage(
  resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
);

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => fileHistoryStorage.flush());
}

interface FilesPanelState {
  open: boolean;
  workspaceRootOverride: string | null;
  previewPath: string | null;
  previewPosition: PathPosition | null;
  fileOpenRequest: {
    path: string;
    position: PathPosition | null;
    workspaceRootOverride: string | null;
    requestId: number;
  } | null;
  directoryNavigationRequest: {
    path: string;
    workspaceRootOverride: string | null;
    requestId: number;
  } | null;
  workspaceKey: string | null;
  histories: Record<string, FileHistory>;
  historyKeys: ReadonlyArray<string>;
  setOpen: (open: boolean) => void;
  setWorkspaceRootOverride: (workspaceRootOverride: string | null) => void;
  setPreviewPath: (previewPath: string | null) => void;
  setPreviewPosition: (previewPosition: PathPosition | null) => void;
  requestFileOpen: (
    path: string,
    position: PathPosition | null,
    workspaceRootOverride: string | null,
  ) => void;
  requestDirectoryNavigation: (path: string, workspaceRootOverride: string | null) => void;
  consumeFileOpenRequest: (requestId: number) => void;
  consumeDirectoryNavigationRequest: (requestId: number) => void;
  setWorkspaceKey: (workspaceKey: string | null) => void;
  openPreview: (entry: FileHistoryEntry) => void;
  closePreview: () => void;
  showCurrentPreview: () => void;
  moveHistory: (delta: -1 | 1) => void;
  removeHistoryPaths: (workspaceKey: string, paths: ReadonlyArray<string>) => number;
  updateHistoryEntry: (
    path: string,
    update: { scrollTop?: number | null; position?: PathPosition | null },
  ) => void;
}

function updateWorkspaceHistory(
  state: Pick<FilesPanelState, "histories" | "historyKeys">,
  key: string,
  history: FileHistory,
) {
  const histories = { ...state.histories, [key]: history };
  const historyKeys = [...state.historyKeys.filter((candidate) => candidate !== key), key];
  while (historyKeys.length > FILE_HISTORY_WORKSPACE_LIMIT) {
    const evictedKey = historyKeys.shift();
    if (evictedKey) delete histories[evictedKey];
  }
  return { histories, historyKeys };
}

function normalizedPersistedHistories(value: unknown): {
  histories: Record<string, FileHistory>;
  historyKeys: ReadonlyArray<string>;
} {
  if (typeof value !== "object" || value === null) return { histories: {}, historyKeys: [] };
  const persisted = value as { histories?: unknown; historyKeys?: unknown };
  if (typeof persisted.histories !== "object" || persisted.histories === null) {
    return { histories: {}, historyKeys: [] };
  }

  const histories = Object.fromEntries(
    Object.entries(persisted.histories)
      .slice(-FILE_HISTORY_WORKSPACE_LIMIT)
      .map(([key, history]) => [key, normalizeFileHistory(history)]),
  );
  const storedKeys = Array.isArray(persisted.historyKeys)
    ? persisted.historyKeys.filter(
        (key): key is string => typeof key === "string" && histories[key] !== undefined,
      )
    : [];
  const storedKeySet = new Set(storedKeys);
  const historyKeys = [
    ...Object.keys(histories).filter((key) => !storedKeySet.has(key)),
    ...storedKeys,
  ].slice(-FILE_HISTORY_WORKSPACE_LIMIT);
  return { histories, historyKeys };
}

export const useFilesPanelStore = create<FilesPanelState>()(
  persist(
    (set) => ({
      open: false,
      workspaceRootOverride: null,
      previewPath: null,
      previewPosition: null,
      fileOpenRequest: null,
      directoryNavigationRequest: null,
      workspaceKey: null,
      histories: {},
      historyKeys: [],
      setOpen: (open) => set({ open }),
      setWorkspaceRootOverride: (workspaceRootOverride) => set({ workspaceRootOverride }),
      setPreviewPath: (previewPath) => set({ previewPath }),
      setPreviewPosition: (previewPosition) => set({ previewPosition }),
      requestFileOpen: (path, position, workspaceRootOverride) =>
        set((state) => ({
          workspaceRootOverride,
          fileOpenRequest: {
            path,
            position,
            workspaceRootOverride,
            requestId: (state.fileOpenRequest?.requestId ?? 0) + 1,
          },
        })),
      requestDirectoryNavigation: (path, workspaceRootOverride) =>
        set((state) => ({
          workspaceRootOverride,
          directoryNavigationRequest: {
            path,
            workspaceRootOverride,
            requestId: (state.directoryNavigationRequest?.requestId ?? 0) + 1,
          },
        })),
      consumeFileOpenRequest: (requestId) =>
        set((state) =>
          state.fileOpenRequest?.requestId === requestId ? { fileOpenRequest: null } : state,
        ),
      consumeDirectoryNavigationRequest: (requestId) =>
        set((state) =>
          state.directoryNavigationRequest?.requestId === requestId
            ? { directoryNavigationRequest: null }
            : state,
        ),
      setWorkspaceKey: (workspaceKey) =>
        set({ workspaceKey, previewPath: null, previewPosition: null }),
      openPreview: (entry) =>
        set((state) => {
          const key = state.workspaceKey;
          if (!key) return state;
          const history = openFileInHistory(state.histories[key] ?? emptyFileHistory(), entry);
          return {
            previewPath: entry.path,
            previewPosition: entry.position,
            ...updateWorkspaceHistory(state, key, history),
          };
        }),
      closePreview: () => set({ previewPath: null, previewPosition: null }),
      showCurrentPreview: () =>
        set((state) => {
          const history = state.workspaceKey ? state.histories[state.workspaceKey] : undefined;
          const entry = history?.entries[history.index];
          return { previewPath: entry?.path ?? null, previewPosition: entry?.position ?? null };
        }),
      moveHistory: (delta) =>
        set((state) => {
          const key = state.workspaceKey;
          if (!key) return state;
          const history = moveFileHistory(state.histories[key] ?? emptyFileHistory(), delta);
          const entry = history.entries[history.index];
          return {
            previewPath: entry?.path ?? null,
            previewPosition: entry?.position ?? null,
            ...updateWorkspaceHistory(state, key, history),
          };
        }),
      removeHistoryPaths: (workspaceKey, paths) => {
        let removedCount = 0;
        set((state) => {
          if (paths.length === 0) return state;
          const removesPath = (candidate: string) =>
            paths.some((path) => candidate === path || candidate.startsWith(`${path}/`));
          const currentHistory = state.histories[workspaceKey] ?? emptyFileHistory();
          removedCount = currentHistory.entries.filter((entry) => removesPath(entry.path)).length;
          if (removedCount === 0) return state;
          const history = currentHistory.entries.reduce(
            (next, entry) =>
              removesPath(entry.path) ? removeFileFromHistory(next, entry.path) : next,
            currentHistory,
          );
          return {
            ...(state.workspaceKey === workspaceKey &&
            state.previewPath &&
            removesPath(state.previewPath)
              ? { previewPath: null, previewPosition: null }
              : {}),
            ...updateWorkspaceHistory(state, workspaceKey, history),
          };
        });
        return removedCount;
      },
      updateHistoryEntry: (path, update) =>
        set((state) => {
          const key = state.workspaceKey;
          if (!key) return state;
          const currentHistory = state.histories[key] ?? emptyFileHistory();
          const entryIndex = currentHistory.entries.findIndex((entry) => entry.path === path);
          if (entryIndex < 0) return state;
          const updatedHistory = updateCurrentFileHistoryEntry(
            { entries: currentHistory.entries, index: entryIndex },
            update,
          );
          const history = { entries: updatedHistory.entries, index: currentHistory.index };
          return {
            ...(update.position !== undefined && state.previewPath === path
              ? { previewPosition: update.position }
              : {}),
            ...updateWorkspaceHistory(state, key, history),
          };
        }),
    }),
    {
      name: FILE_HISTORY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => fileHistoryStorage),
      partialize: (state) => ({ histories: state.histories, historyKeys: state.historyKeys }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizedPersistedHistories(persistedState),
      }),
    },
  ),
);
