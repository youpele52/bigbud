import { afterEach, describe, expect, it } from "vitest";

import { closeGitPanel, openGitPanelToView, toggleGitPanel } from "./gitPanel.coordinator";
import { getRequestedRightPanel, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useGitPanelViewStore } from "./gitPanelView.store";

describe("gitPanel.coordinator", () => {
  afterEach(() => {
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
    });
    useGitPanelViewStore.setState({ activeView: "changes" });
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

describe("openGitPanelToView", () => {
  afterEach(() => {
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
    });
    useGitPanelViewStore.setState({ activeView: "changes" });
    requestRightPanel(null);
  });

  it("opens git to the requested view when the panel is closed", () => {
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
    });

    openGitPanelToView("history");

    expect(useGitPanelViewStore.getState().activeView).toBe("history");
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "git",
      activeTabId: "git",
      openTabs: ["git"],
      rightPanelOpen: true,
    });
  });

  it("switches view without closing when git is open on a different view", () => {
    useRightPanelTabsStore.setState({
      activeKind: "git",
      activeTabId: "git",
      openTabs: ["git"],
      rightPanelOpen: true,
    });
    useGitPanelViewStore.setState({ activeView: "changes" });

    openGitPanelToView("history");

    expect(useGitPanelViewStore.getState().activeView).toBe("history");
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "git",
      activeTabId: "git",
      openTabs: ["git"],
      rightPanelOpen: true,
    });
  });

  it("closes git when toggling the same active view", () => {
    requestRightPanel("git");
    useRightPanelTabsStore.setState({
      activeKind: "git",
      activeTabId: "git",
      openTabs: ["git"],
      rightPanelOpen: true,
    });
    useGitPanelViewStore.setState({ activeView: "history" });

    openGitPanelToView("history");

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
    });
    expect(getRequestedRightPanel()).toBeNull();
  });

  it("activates git to the requested view when its tab is in the background", () => {
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      activeTabId: "browser",
      openTabs: ["git", "browser"],
      rightPanelOpen: true,
    });
    useGitPanelViewStore.setState({ activeView: "changes" });

    openGitPanelToView("history");

    expect(useGitPanelViewStore.getState().activeView).toBe("history");
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "git",
      activeTabId: "git",
      openTabs: ["git", "browser"],
      rightPanelOpen: true,
    });
  });
});
