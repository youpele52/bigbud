import { create } from "zustand";

interface BrowserTabState {
  title: string;
  url: string;
  openedByAgent?: true;
  agentLease?: {
    readonly leaseId: string;
    readonly threadId: string;
    readonly turnId: string;
  };
  agentCursor?: { readonly x: number; readonly y: number };
  agentHandoff?: { readonly leaseId: string; readonly releasedAt: number };
}

interface BrowserPanelState {
  open: boolean;
  tabsById: Record<string, BrowserTabState>;
  setOpen: (open: boolean) => void;
  ensureTab: (tabId: string, url?: string) => void;
  markTabOpenedByAgent: (tabId: string) => void;
  setTabTitle: (tabId: string, title: string) => void;
  setTabUrl: (tabId: string, url: string) => void;
  setAgentLease: (
    tabId: string,
    lease: { readonly leaseId: string; readonly threadId: string; readonly turnId: string },
  ) => void;
  clearAgentLease: (tabId: string, leaseId?: string) => void;
  setAgentCursor: (
    tabId: string,
    cursor: { readonly x: number; readonly y: number } | null,
  ) => void;
  reconcileAgentLeases: (
    leases: ReadonlyArray<{
      readonly leaseId: string;
      readonly tabId: string;
      readonly threadId: string;
      readonly turnId: string;
    }>,
  ) => void;
  clearAgentHandoff: (tabId: string, leaseId: string) => void;
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
            ...(currentTab?.agentLease ? { agentLease: currentTab.agentLease } : {}),
            ...(currentTab?.agentCursor ? { agentCursor: currentTab.agentCursor } : {}),
            ...(currentTab?.agentHandoff ? { agentHandoff: currentTab.agentHandoff } : {}),
            ...(currentTab?.openedByAgent ? { openedByAgent: true } : {}),
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
            ...(currentTab?.agentLease ? { agentLease: currentTab.agentLease } : {}),
            ...(currentTab?.agentCursor ? { agentCursor: currentTab.agentCursor } : {}),
            ...(currentTab?.agentHandoff ? { agentHandoff: currentTab.agentHandoff } : {}),
            ...(currentTab?.openedByAgent ? { openedByAgent: true } : {}),
          },
        },
      };
    }),
  setAgentLease: (tabId, lease) =>
    set((state) => {
      const currentTab = state.tabsById[tabId];
      if (!currentTab) return state;
      const tab =
        currentTab.agentLease?.leaseId === lease.leaseId
          ? currentTab
          : (() => {
              const { agentCursor: _, agentHandoff: __, ...withoutAgentState } = currentTab;
              return withoutAgentState;
            })();
      return {
        tabsById: {
          ...state.tabsById,
          [tabId]: { ...tab, agentLease: lease },
        },
      };
    }),
  markTabOpenedByAgent: (tabId) =>
    set((state) => {
      const tab = state.tabsById[tabId];
      if (!tab || tab.openedByAgent) return state;
      return { tabsById: { ...state.tabsById, [tabId]: { ...tab, openedByAgent: true } } };
    }),
  clearAgentLease: (tabId, leaseId) =>
    set((state) => {
      const currentTab = state.tabsById[tabId];
      if (!currentTab?.agentLease || (leaseId && currentTab.agentLease.leaseId !== leaseId)) {
        return state;
      }
      const { agentLease: _, agentCursor: __, ...tab } = currentTab;
      return {
        tabsById: {
          ...state.tabsById,
          [tabId]: {
            ...tab,
            agentHandoff: { leaseId: currentTab.agentLease.leaseId, releasedAt: Date.now() },
          },
        },
      };
    }),
  setAgentCursor: (tabId, cursor) =>
    set((state) => {
      const currentTab = state.tabsById[tabId];
      if (!currentTab?.agentLease) return state;
      if (currentTab.agentCursor?.x === cursor?.x && currentTab.agentCursor?.y === cursor?.y) {
        return state;
      }
      const { agentCursor: _, ...tab } = currentTab;
      return {
        tabsById: {
          ...state.tabsById,
          [tabId]: cursor ? { ...currentTab, agentCursor: cursor } : tab,
        },
      };
    }),
  reconcileAgentLeases: (leases) =>
    set((state) => {
      const leasesByTabId = new Map(leases.map((lease) => [lease.tabId, lease]));
      let changed = false;
      const tabsById = Object.fromEntries(
        Object.entries(state.tabsById).map(([tabId, tab]) => {
          const lease = leasesByTabId.get(tabId);
          if (!lease) {
            if (!tab.agentLease) return [tabId, tab] as const;
            const { agentLease: _, agentCursor: __, ...withoutLease } = tab;
            changed = true;
            return [
              tabId,
              {
                ...withoutLease,
                agentHandoff: { leaseId: tab.agentLease.leaseId, releasedAt: Date.now() },
              },
            ] as const;
          }
          if (tab.agentLease?.leaseId === lease.leaseId) return [tabId, tab] as const;
          const { agentCursor: _, agentHandoff: __, ...withoutAgentState } = tab;
          changed = true;
          return [
            tabId,
            {
              ...withoutAgentState,
              agentLease: {
                leaseId: lease.leaseId,
                threadId: lease.threadId,
                turnId: lease.turnId,
              },
            },
          ] as const;
        }),
      );
      return changed ? { tabsById } : state;
    }),
  clearAgentHandoff: (tabId, leaseId) =>
    set((state) => {
      const tab = state.tabsById[tabId];
      if (!tab?.agentHandoff || tab.agentHandoff.leaseId !== leaseId) return state;
      const { agentHandoff: _, ...withoutHandoff } = tab;
      return { tabsById: { ...state.tabsById, [tabId]: withoutHandoff } };
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
