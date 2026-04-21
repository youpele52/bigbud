import { create } from "zustand";

interface SearchState {
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  toggleSearchOpen: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  searchOpen: false,
  setSearchOpen: (open) =>
    set((state) => (state.searchOpen === open ? state : { searchOpen: open })),
  toggleSearchOpen: () => set((state) => ({ searchOpen: !state.searchOpen })),
}));
