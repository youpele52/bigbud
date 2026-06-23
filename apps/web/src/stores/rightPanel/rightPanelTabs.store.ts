import { create } from "zustand";

import { randomUUID } from "~/lib/utils";

export type RightPanelTabKind =
  | "browser"
  | "diff"
  | "files"
  | "git"
  | "kanban"
  | "notes"
  | "terminal";
export type RightPanelTabId = RightPanelTabKind | `browser:${string}`;

export const MAX_RIGHT_PANEL_BROWSER_TABS = 5;

interface OpenBrowserTabResult {
  status: "activated" | "created" | "limit_reached";
  tabId: RightPanelTabId | null;
}

interface RightPanelTabsState {
  activeKind: RightPanelTabKind | null;
  activeTabId: RightPanelTabId | null;
  openTabs: ReadonlyArray<RightPanelTabId>;
  rightPanelOpen: boolean;
  lastActiveKind: RightPanelTabKind | null;
  closeTab: (kind: RightPanelTabKind) => void;
  closeTabById: (tabId: RightPanelTabId) => void;
  ensureTabOpen: (kind: Exclude<RightPanelTabKind, "browser">) => void;
  moveTab: (
    tabId: RightPanelTabId,
    targetTabId: RightPanelTabId,
    position: "before" | "after",
  ) => void;
  openTab: (kind: Exclude<RightPanelTabKind, "browser">) => void;
  openBrowserTab: () => OpenBrowserTabResult;
  setActiveTab: (tabId: RightPanelTabId) => void;
  toggleRightPanel: () => void;
  showLauncher: () => void;
  openRightPanel: () => void;
  closeRightPanel: () => void;
}

const BROWSER_TAB_PREFIX = "browser:";

export function getRightPanelTabKind(tabId: RightPanelTabId): RightPanelTabKind {
  return tabId.startsWith(BROWSER_TAB_PREFIX) ? "browser" : (tabId as RightPanelTabKind);
}

export function isRightPanelTabOfKind(tabId: RightPanelTabId, kind: RightPanelTabKind): boolean {
  return getRightPanelTabKind(tabId) === kind;
}

export function countRightPanelTabsByKind(
  openTabs: ReadonlyArray<RightPanelTabId>,
  kind: RightPanelTabKind,
): number {
  return openTabs.filter((tabId) => isRightPanelTabOfKind(tabId, kind)).length;
}

export function selectLastRightPanelTabIdByKind(
  openTabs: ReadonlyArray<RightPanelTabId>,
  kind: RightPanelTabKind,
): RightPanelTabId | null {
  for (let index = openTabs.length - 1; index >= 0; index -= 1) {
    const tabId = openTabs[index];
    if (tabId && isRightPanelTabOfKind(tabId, kind)) {
      return tabId;
    }
  }

  return null;
}

function appendTabIfMissing(
  openTabs: ReadonlyArray<RightPanelTabId>,
  tabId: RightPanelTabId,
): ReadonlyArray<RightPanelTabId> {
  return openTabs.includes(tabId) ? openTabs : [...openTabs, tabId];
}

function moveTabInOrder(
  openTabs: ReadonlyArray<RightPanelTabId>,
  tabId: RightPanelTabId,
  targetTabId: RightPanelTabId,
  position: "before" | "after",
): ReadonlyArray<RightPanelTabId> {
  if (tabId === targetTabId) {
    return openTabs;
  }

  const sourceIndex = openTabs.indexOf(tabId);
  const targetIndex = openTabs.indexOf(targetTabId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return openTabs;
  }

  const nextTabs = [...openTabs];
  nextTabs.splice(sourceIndex, 1);

  const targetIndexAfterRemoval = nextTabs.indexOf(targetTabId);
  if (targetIndexAfterRemoval === -1) {
    return openTabs;
  }

  const insertIndex = position === "before" ? targetIndexAfterRemoval : targetIndexAfterRemoval + 1;
  nextTabs.splice(insertIndex, 0, tabId);

  return nextTabs.every((nextTabId, index) => nextTabId === openTabs[index]) ? openTabs : nextTabs;
}

function resolveNextActiveTabId(
  previousTabs: ReadonlyArray<RightPanelTabId>,
  nextTabs: ReadonlyArray<RightPanelTabId>,
  activeTabId: RightPanelTabId | null,
): RightPanelTabId | null {
  if (activeTabId === null) {
    return null;
  }

  if (nextTabs.includes(activeTabId)) {
    return activeTabId;
  }

  const closedTabIndex = previousTabs.indexOf(activeTabId);
  if (closedTabIndex === -1) {
    return nextTabs[0] ?? null;
  }

  return (
    nextTabs[Math.max(0, closedTabIndex - 1)] ??
    nextTabs[Math.min(closedTabIndex, nextTabs.length - 1)] ??
    null
  );
}

function buildActiveState(activeTabId: RightPanelTabId | null) {
  return {
    activeTabId,
    activeKind: activeTabId ? getRightPanelTabKind(activeTabId) : null,
  };
}

export const useRightPanelTabsStore = create<RightPanelTabsState>((set) => ({
  activeKind: null,
  activeTabId: null,
  openTabs: [],
  rightPanelOpen: false,
  lastActiveKind: null,
  closeTab: (kind) =>
    set((state) => {
      const nextTabs = state.openTabs.filter((tabId) => !isRightPanelTabOfKind(tabId, kind));
      if (nextTabs.length === state.openTabs.length) {
        return state;
      }

      const nextActiveTabId = resolveNextActiveTabId(state.openTabs, nextTabs, state.activeTabId);
      const shouldClose = nextTabs.length === 0;

      return {
        openTabs: nextTabs,
        ...buildActiveState(nextActiveTabId),
        lastActiveKind: nextActiveTabId
          ? getRightPanelTabKind(nextActiveTabId)
          : state.lastActiveKind,
        rightPanelOpen: shouldClose ? false : state.rightPanelOpen,
      };
    }),
  closeTabById: (tabId) =>
    set((state) => {
      if (!state.openTabs.includes(tabId)) {
        return state;
      }

      const nextTabs = state.openTabs.filter((openTabId) => openTabId !== tabId);
      const nextActiveTabId = resolveNextActiveTabId(state.openTabs, nextTabs, state.activeTabId);
      const shouldClose = nextTabs.length === 0;

      return {
        openTabs: nextTabs,
        ...buildActiveState(nextActiveTabId),
        lastActiveKind: nextActiveTabId
          ? getRightPanelTabKind(nextActiveTabId)
          : state.lastActiveKind,
        rightPanelOpen: shouldClose ? false : state.rightPanelOpen,
      };
    }),
  ensureTabOpen: (kind) =>
    set((state) => {
      const nextTabs = appendTabIfMissing(state.openTabs, kind);
      const activeTabId = state.activeTabId ?? kind;

      return {
        openTabs: nextTabs,
        ...buildActiveState(activeTabId),
        lastActiveKind: state.lastActiveKind ?? getRightPanelTabKind(activeTabId),
        rightPanelOpen: true,
      };
    }),
  moveTab: (tabId, targetTabId, position) =>
    set((state) => {
      const nextTabs = moveTabInOrder(state.openTabs, tabId, targetTabId, position);
      return nextTabs === state.openTabs ? state : { openTabs: nextTabs };
    }),
  openTab: (kind) =>
    set((state) => ({
      openTabs: appendTabIfMissing(state.openTabs, kind),
      ...buildActiveState(kind),
      lastActiveKind: kind,
      rightPanelOpen: true,
    })),
  openBrowserTab: () => {
    let result: OpenBrowserTabResult = { status: "limit_reached", tabId: null };

    set((state) => {
      if (countRightPanelTabsByKind(state.openTabs, "browser") >= MAX_RIGHT_PANEL_BROWSER_TABS) {
        const existingTabId = selectLastRightPanelTabIdByKind(state.openTabs, "browser");
        result = { status: "limit_reached", tabId: existingTabId };
        return state;
      }

      const tabId = `${BROWSER_TAB_PREFIX}${randomUUID()}` as RightPanelTabId;
      result = { status: "created", tabId };

      return {
        openTabs: [...state.openTabs, tabId],
        ...buildActiveState(tabId),
        lastActiveKind: "browser",
        rightPanelOpen: true,
      };
    });

    return result;
  },
  setActiveTab: (tabId) =>
    set((state) =>
      state.openTabs.includes(tabId)
        ? {
            ...buildActiveState(tabId),
            lastActiveKind: getRightPanelTabKind(tabId),
            rightPanelOpen: true,
          }
        : state,
    ),
  toggleRightPanel: () =>
    set((state) => {
      if (state.rightPanelOpen) {
        return { rightPanelOpen: false };
      }
      // When opening, restore last active tab or stay on launcher (activeKind === null)
      return { rightPanelOpen: true };
    }),
  showLauncher: () =>
    set((state) => ({
      activeKind: null,
      activeTabId: null,
      lastActiveKind: state.lastActiveKind,
      rightPanelOpen: true,
    })),
  openRightPanel: () => set({ rightPanelOpen: true }),
  closeRightPanel: () => set({ rightPanelOpen: false }),
}));
