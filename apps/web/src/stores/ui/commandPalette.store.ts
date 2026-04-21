import { create } from "zustand";

interface CommandPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  setOpen: (open) => set((state) => (state.open === open ? state : { open })),
  toggleOpen: () => set((state) => ({ open: !state.open })),
}));
