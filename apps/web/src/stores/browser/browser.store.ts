import { create } from "zustand";

interface BrowserPanelState {
  open: boolean;
  url: string;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setUrl: (url: string) => void;
}

export const useBrowserPanelStore = create<BrowserPanelState>((set) => ({
  open: false,
  url: "",
  toggle: () => set((state) => ({ open: !state.open })),
  setOpen: (open) => set({ open }),
  setUrl: (url) => set({ url }),
}));
