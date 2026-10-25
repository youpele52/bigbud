import { afterEach, describe, expect, it } from "vitest";

import { useRightPanelTabsStore } from "./rightPanelTabs.store";
import { closeActiveRightPanelTab } from "./rightPanel.closeActiveTab";

describe("rightPanel.closeActiveTab", () => {
  afterEach(() => {
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
      lastActiveKind: null,
    });
  });

  it("closes the active right panel tab when the panel is open", () => {
    useRightPanelTabsStore.getState().openTab("files");
    useRightPanelTabsStore.getState().openTab("git");

    expect(closeActiveRightPanelTab()).toBe(true);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(["files"]);
    expect(useRightPanelTabsStore.getState().activeTabId).toBe("files");
  });

  it("does nothing when the right panel is closed", () => {
    useRightPanelTabsStore.getState().openTab("files");
    useRightPanelTabsStore.getState().closeRightPanel();

    expect(closeActiveRightPanelTab()).toBe(false);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(["files"]);
  });

  it("restores Usage selection on reopen and closes it with the existing active-tab shortcut", () => {
    useRightPanelTabsStore.getState().openTab("system");
    useRightPanelTabsStore.getState().openTab("usage");
    useRightPanelTabsStore.getState().openTab("usage");
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(["system", "usage"]);
    useRightPanelTabsStore.getState().toggleRightPanel();
    useRightPanelTabsStore.getState().toggleRightPanel();
    expect(useRightPanelTabsStore.getState().activeTabId).toBe("usage");
    expect(closeActiveRightPanelTab()).toBe(true);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(["system"]);
    expect(useRightPanelTabsStore.getState().activeTabId).toBe("system");
  });

  it("does nothing when the launcher is showing", () => {
    useRightPanelTabsStore.getState().openTab("files");
    useRightPanelTabsStore.getState().showLauncher();

    expect(closeActiveRightPanelTab()).toBe(false);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(["files"]);
  });
});
