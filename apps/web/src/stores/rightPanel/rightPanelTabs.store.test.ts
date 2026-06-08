import { afterEach, describe, expect, it } from "vitest";

import {
  countRightPanelTabsByKind,
  MAX_RIGHT_PANEL_BROWSER_TABS,
  useRightPanelTabsStore,
} from "./rightPanelTabs.store";

describe("rightPanelTabs.store", () => {
  afterEach(() => {
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      lastActiveKind: null,
      openTabs: [],
      rightPanelOpen: false,
    });
  });

  it("keeps the current tab active when ensuring another tab stays open", () => {
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      activeTabId: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser"],
      rightPanelOpen: true,
    });

    useRightPanelTabsStore.getState().ensureTabOpen("diff");

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      activeTabId: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser", "diff"],
      rightPanelOpen: true,
    });
  });

  it("activates an already-open tab without reordering it", () => {
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      activeTabId: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
    });

    useRightPanelTabsStore.getState().openTab("files");

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      activeTabId: "files",
      lastActiveKind: "files",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
    });
  });

  it("opens notes tabs like other singleton right panel tabs", () => {
    useRightPanelTabsStore.getState().openTab("notes");

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "notes",
      activeTabId: "notes",
      lastActiveKind: "notes",
      openTabs: ["notes"],
      rightPanelOpen: true,
    });
  });

  it("closes the active middle tab and selects the nearest left tab", () => {
    useRightPanelTabsStore.setState({
      activeKind: "files",
      activeTabId: "files",
      lastActiveKind: "files",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
    });

    useRightPanelTabsStore.getState().closeTab("files");

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      activeTabId: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser", "terminal"],
      rightPanelOpen: true,
    });
  });

  it("opens up to five browser tabs and then rejects more", () => {
    const createdTabIds = [] as string[];

    for (let index = 0; index < MAX_RIGHT_PANEL_BROWSER_TABS; index += 1) {
      const result = useRightPanelTabsStore.getState().openBrowserTab();
      expect(result.status).toBe("created");
      expect(result.tabId).toBeTruthy();
      createdTabIds.push(result.tabId ?? "");
    }

    const limitResult = useRightPanelTabsStore.getState().openBrowserTab();

    expect(limitResult.status).toBe("limit_reached");
    expect(countRightPanelTabsByKind(useRightPanelTabsStore.getState().openTabs, "browser")).toBe(
      MAX_RIGHT_PANEL_BROWSER_TABS,
    );
    expect(new Set(createdTabIds).size).toBe(MAX_RIGHT_PANEL_BROWSER_TABS);
  });

  it("closes one browser tab without removing other browser tabs", () => {
    const first = useRightPanelTabsStore.getState().openBrowserTab();
    const second = useRightPanelTabsStore.getState().openBrowserTab();
    expect(second.tabId).toBeTruthy();

    useRightPanelTabsStore.getState().closeTabById(second.tabId as `browser:${string}`);

    const state = useRightPanelTabsStore.getState();
    expect(state.activeKind).toBe("browser");
    expect(state.activeTabId).toBe(first.tabId);
    expect(countRightPanelTabsByKind(state.openTabs, "browser")).toBe(1);
  });

  it("shows the launcher without closing existing tabs", () => {
    useRightPanelTabsStore.setState({
      activeKind: "files",
      activeTabId: "files",
      lastActiveKind: "files",
      openTabs: ["browser:1", "files", "terminal"],
      rightPanelOpen: false,
    });

    useRightPanelTabsStore.getState().showLauncher();

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: null,
      activeTabId: null,
      lastActiveKind: "files",
      openTabs: ["browser:1", "files", "terminal"],
      rightPanelOpen: true,
    });
  });
});
