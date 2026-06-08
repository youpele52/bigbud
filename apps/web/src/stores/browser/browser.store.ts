import { create } from "zustand";

interface BrowserTabState {
  title: string;
  url: string;
}

interface BrowserPanelState {
  open: boolean;
  tabsById: Record<string, BrowserTabState>;
  setOpen: (open: boolean) => void;
  ensureTab: (tabId: string, url?: string) => void;
  setTabTitle: (tabId: string, title: string) => void;
  setTabUrl: (tabId: string, url: string) => void;
  removeTab: (tabId: string) => void;
  removeTabs: (tabIds: ReadonlyArray<string>) => void;
  clearTabs: () => void;
}

export const useBrowserPanelStore = create<BrowserPanelState>((set) => ({
  open: false,
  tabsById: {},
  setOpen: (open) => set({ open }),
  ensureTab: (tabId, url = "") =>
    set((state) => {
      if (state.tabsById[tabId]) {
        return state;
      }

      return {
        tabsById: {
          ...state.tabsById,
          [tabId]: { title: "", url },
        },
      };
    }),
  setTabTitle: (tabId, title) =>
    set((state) => {
      const currentTab = state.tabsById[tabId];
      if (currentTab?.title === title) {
        return state;
      }

      return {
        tabsById: {
          ...state.tabsById,
          [tabId]: {
            title,
            url: currentTab?.url ?? "",
          },
        },
      };
    }),
  setTabUrl: (tabId, url) =>
    set((state) => {
      const currentTab = state.tabsById[tabId];
      if (currentTab?.url === url) {
        return state;
      }

      return {
        tabsById: {
          ...state.tabsById,
          [tabId]: {
            title: currentTab?.title ?? "",
            url,
          },
        },
      };
    }),
  removeTab: (tabId) =>
    set((state) => {
      if (!state.tabsById[tabId]) {
        return state;
      }

      const nextTabsById = { ...state.tabsById };
      delete nextTabsById[tabId];
      return { tabsById: nextTabsById };
    }),
  removeTabs: (tabIds) =>
    set((state) => {
      let mutated = false;
      const nextTabsById = { ...state.tabsById };

      for (const tabId of tabIds) {
        if (nextTabsById[tabId]) {
          delete nextTabsById[tabId];
          mutated = true;
        }
      }

      return mutated ? { tabsById: nextTabsById } : state;
    }),
  clearTabs: () => set({ tabsById: {} }),
}));
