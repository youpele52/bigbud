import type { PathPosition } from "../../models/editor";
import { create } from "zustand";

interface FilesPanelState {
  open: boolean;
  previewPath: string | null;
  previewPosition: PathPosition | null;
  setOpen: (open: boolean) => void;
  setPreviewPath: (previewPath: string | null) => void;
  setPreviewPosition: (previewPosition: PathPosition | null) => void;
}

export const useFilesPanelStore = create<FilesPanelState>((set) => ({
  open: false,
  previewPath: null,
  previewPosition: null,
  setOpen: (open) => set({ open }),
  setPreviewPath: (previewPath) => set({ previewPath }),
  setPreviewPosition: (previewPosition) => set({ previewPosition }),
}));
