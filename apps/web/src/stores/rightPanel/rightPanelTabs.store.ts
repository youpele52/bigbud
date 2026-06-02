import { create } from "zustand";

export type RightPanelTabKind = "browser" | "files" | "terminal";

interface RightPanelTabsState {
  activeKind: RightPanelTabKind | null;
  openTabs: ReadonlyArray<RightPanelTabKind>;
  closeTab: (kind: RightPanelTabKind) => void;
  openTab: (kind: RightPanelTabKind) => void;
  setActiveTab: (kind: RightPanelTabKind) => void;
}

export const useRightPanelTabsStore = create<RightPanelTabsState>((set) => ({
  activeKind: null,
  openTabs: [],
  closeTab: (kind) =>
    set((state) => {
      if (!state.openTabs.includes(kind)) {
        return state;
      }

      const nextTabs = state.openTabs.filter((tab) => tab !== kind);
      return {
        openTabs: nextTabs,
        activeKind:
          state.activeKind === kind ? (nextTabs[nextTabs.length - 1] ?? null) : state.activeKind,
      };
    }),
  openTab: (kind) =>
    set((state) => ({
      activeKind: kind,
      openTabs: state.openTabs.includes(kind) ? state.openTabs : [...state.openTabs, kind],
    })),
  setActiveTab: (kind) =>
    set((state) => (state.openTabs.includes(kind) ? { activeKind: kind } : state)),
}));
