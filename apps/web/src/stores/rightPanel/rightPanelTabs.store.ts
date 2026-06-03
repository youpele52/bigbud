import { create } from "zustand";

export type RightPanelTabKind = "browser" | "diff" | "files" | "terminal";

interface RightPanelTabsState {
  activeKind: RightPanelTabKind | null;
  openTabs: ReadonlyArray<RightPanelTabKind>;
  rightPanelOpen: boolean;
  lastActiveKind: RightPanelTabKind | null;
  closeTab: (kind: RightPanelTabKind) => void;
  ensureTabOpen: (kind: RightPanelTabKind) => void;
  openTab: (kind: RightPanelTabKind) => void;
  setActiveTab: (kind: RightPanelTabKind) => void;
  toggleRightPanel: () => void;
  openRightPanel: () => void;
  closeRightPanel: () => void;
}

export const useRightPanelTabsStore = create<RightPanelTabsState>((set) => ({
  activeKind: null,
  openTabs: [],
  rightPanelOpen: false,
  lastActiveKind: null,
  closeTab: (kind) =>
    set((state) => {
      if (!state.openTabs.includes(kind)) {
        return state;
      }

      const nextTabs = state.openTabs.filter((tab) => tab !== kind);
      const nextActive =
        state.activeKind === kind ? (nextTabs[nextTabs.length - 1] ?? null) : state.activeKind;
      const shouldClose = nextTabs.length === 0;

      return {
        openTabs: nextTabs,
        activeKind: nextActive,
        lastActiveKind: nextActive ?? state.lastActiveKind,
        rightPanelOpen: shouldClose ? false : state.rightPanelOpen,
      };
    }),
  ensureTabOpen: (kind) =>
    set((state) => ({
      activeKind: state.activeKind ?? kind,
      lastActiveKind: state.lastActiveKind ?? kind,
      openTabs: state.openTabs.includes(kind) ? state.openTabs : [...state.openTabs, kind],
      rightPanelOpen: true,
    })),
  openTab: (kind) =>
    set((state) => ({
      activeKind: kind,
      lastActiveKind: kind,
      openTabs: state.openTabs.includes(kind) ? state.openTabs : [...state.openTabs, kind],
      rightPanelOpen: true,
    })),
  setActiveTab: (kind) =>
    set((state) =>
      state.openTabs.includes(kind) ? { activeKind: kind, lastActiveKind: kind } : state,
    ),
  toggleRightPanel: () =>
    set((state) => {
      if (state.rightPanelOpen) {
        return { rightPanelOpen: false };
      }
      // When opening, restore last active tab or stay on launcher (activeKind === null)
      return { rightPanelOpen: true };
    }),
  openRightPanel: () => set({ rightPanelOpen: true }),
  closeRightPanel: () => set({ rightPanelOpen: false }),
}));
