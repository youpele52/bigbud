import { create } from "zustand";

interface FilesPanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useFilesPanelStore = create<FilesPanelState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
