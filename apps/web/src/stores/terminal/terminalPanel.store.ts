import { create } from "zustand";

interface TerminalPanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useTerminalPanelStore = create<TerminalPanelState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
