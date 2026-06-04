import { afterEach, describe, expect, it } from "vitest";

import { useRightPanelTabsStore } from "./rightPanelTabs.store";

describe("rightPanelTabs.store", () => {
  afterEach(() => {
    useRightPanelTabsStore.setState({
      activeKind: null,
      lastActiveKind: null,
      openTabs: [],
      rightPanelOpen: false,
    });
  });

  it("keeps the current tab active when ensuring another tab stays open", () => {
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser"],
      rightPanelOpen: true,
    });

    useRightPanelTabsStore.getState().ensureTabOpen("diff");

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser", "diff"],
      rightPanelOpen: true,
    });
  });

  it("activates an already-open tab without reordering it", () => {
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
    });

    useRightPanelTabsStore.getState().openTab("files");

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      lastActiveKind: "files",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
    });
  });

  it("closes the active middle tab and selects the nearest left tab", () => {
    useRightPanelTabsStore.setState({
      activeKind: "files",
      lastActiveKind: "files",
      openTabs: ["browser", "files", "terminal"],
      rightPanelOpen: true,
    });

    useRightPanelTabsStore.getState().closeTab("files");

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser", "terminal"],
      rightPanelOpen: true,
    });
  });
});
