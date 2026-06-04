import type { PathPosition } from "../../models/editor";
import { create } from "zustand";

interface FilesPanelState {
  open: boolean;
  previewPath: string | null;
  previewPosition: PathPosition | null;
  fileOpenRequest: { path: string; position: PathPosition | null; requestId: number } | null;
  directoryNavigationRequest: { path: string; requestId: number } | null;
  setOpen: (open: boolean) => void;
  setPreviewPath: (previewPath: string | null) => void;
  setPreviewPosition: (previewPosition: PathPosition | null) => void;
  requestFileOpen: (path: string, position: PathPosition | null) => void;
  requestDirectoryNavigation: (path: string) => void;
}

export const useFilesPanelStore = create<FilesPanelState>((set) => ({
  open: false,
  previewPath: null,
  previewPosition: null,
  fileOpenRequest: null,
  directoryNavigationRequest: null,
  setOpen: (open) => set({ open }),
  setPreviewPath: (previewPath) => set({ previewPath }),
  setPreviewPosition: (previewPosition) => set({ previewPosition }),
  requestFileOpen: (path, position) =>
    set((state) => ({
      fileOpenRequest: {
        path,
        position,
        requestId: (state.fileOpenRequest?.requestId ?? 0) + 1,
      },
    })),
  requestDirectoryNavigation: (path) =>
    set((state) => ({
      directoryNavigationRequest: {
        path,
        requestId: (state.directoryNavigationRequest?.requestId ?? 0) + 1,
      },
    })),
}));
