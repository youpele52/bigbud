import type { PathPosition } from "../../models/editor";
import { create } from "zustand";

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
}

export const useFilesPanelStore = create<FilesPanelState>((set) => ({
  open: false,
  workspaceRootOverride: null,
  previewPath: null,
  previewPosition: null,
  fileOpenRequest: null,
  directoryNavigationRequest: null,
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
}));
