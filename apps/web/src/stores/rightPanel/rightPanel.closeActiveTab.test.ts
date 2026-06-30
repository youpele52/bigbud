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

  it("does nothing when the launcher is showing", () => {
    useRightPanelTabsStore.getState().openTab("files");
    useRightPanelTabsStore.getState().showLauncher();

    expect(closeActiveRightPanelTab()).toBe(false);
    expect(useRightPanelTabsStore.getState().openTabs).toEqual(["files"]);
  });
});
