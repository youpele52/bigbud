import { afterEach, describe, expect, it } from "vitest";

import { closeGitPanel, toggleGitPanel } from "./gitPanel.coordinator";
import { getRequestedRightPanel, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";

describe("gitPanel.coordinator", () => {
  afterEach(() => {
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
    });
    requestRightPanel(null);
  });

  it("opens git when it is currently closed", () => {
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: ["browser"],
      rightPanelOpen: false,
    });

    toggleGitPanel();

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "git",
      activeTabId: "git",
      openTabs: ["browser", "git"],
      rightPanelOpen: true,
    });
    expect(getRequestedRightPanel()).toBe("git");
  });

  it("activates git instead of closing it when its tab is already open in the background", () => {
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      activeTabId: "browser",
      openTabs: ["git", "browser"],
      rightPanelOpen: true,
    });

    toggleGitPanel();

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "git",
      activeTabId: "git",
      openTabs: ["git", "browser"],
      rightPanelOpen: true,
    });
    expect(getRequestedRightPanel()).toBe("git");
  });

  it("closes git only when toggling the active git tab", () => {
    requestRightPanel("git");
    useRightPanelTabsStore.setState({
      activeKind: "git",
      activeTabId: "git",
      openTabs: ["git"],
      rightPanelOpen: true,
    });

    toggleGitPanel();

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
    });
    expect(getRequestedRightPanel()).toBeNull();
  });

  it("closeGitPanel preserves the neighboring active tab", () => {
    requestRightPanel("git");
    useRightPanelTabsStore.setState({
      activeKind: "git",
      activeTabId: "git",
      openTabs: ["browser", "git", "files"],
      rightPanelOpen: true,
    });

    closeGitPanel();

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      activeTabId: "browser",
      openTabs: ["browser", "files"],
      rightPanelOpen: true,
    });
  });
});
