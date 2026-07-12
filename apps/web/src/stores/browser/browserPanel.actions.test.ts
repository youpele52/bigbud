import { afterEach, describe, expect, it } from "vitest";

import {
  closeBrowserTab,
  closeBrowserPanel,
  openBrowserPanel,
  openNewBrowserTab,
  toggleBrowserPanel,
} from "./browserPanel.actions";
import { useBrowserPanelStore } from "./browser.store";
import { useBrowserCloseConfirmationStore } from "./browserCloseConfirmation.store";
import { useFilesPanelStore } from "../files/filesPanel.store";
import { getRequestedRightPanel, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import {
  countRightPanelTabsByKind,
  MAX_RIGHT_PANEL_BROWSER_TABS,
  useRightPanelTabsStore,
} from "../rightPanel/rightPanelTabs.store";

describe("browserPanel.actions", () => {
  afterEach(() => {
    useBrowserPanelStore.setState({ open: false, tabsById: {} });
    useBrowserCloseConfirmationStore.getState().dismiss();
    useFilesPanelStore.setState({ open: false });
    useRightPanelTabsStore.setState({
      activeKind: null,
      activeTabId: null,
      openTabs: [],
      rightPanelOpen: false,
    });
    requestRightPanel(null);
  });

  it("opens the browser with a normalized URL", () => {
    openBrowserPanel({ url: " https://example.com/path " });

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);

    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: true,
      tabsById: {
        [browserTabIds[0] ?? ""]: {
          url: "https://example.com/path",
        },
      },
    });
  });

  it("keeps the files tab open while switching the active panel to browser", () => {
    useFilesPanelStore.setState({ open: true });
    requestRightPanel("files");
    useRightPanelTabsStore.setState({
      activeKind: "files",
      activeTabId: "files",
      openTabs: ["files"],
    });

    openBrowserPanel({ url: "https://example.com" });

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);

    expect(useFilesPanelStore.getState().open).toBe(true);
    expect(useBrowserPanelStore.getState().open).toBe(true);
    expect(getRequestedRightPanel()).toBe("browser");
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      activeTabId: browserTabIds[0],
      openTabs: ["files", browserTabIds[0]],
    });
  });

  it("activates the browser instead of closing it when the tab is already open in the background", () => {
    openBrowserPanel({ url: "https://example.com" });
    const browserTabId = Object.keys(useBrowserPanelStore.getState().tabsById)[0] as
      | `browser:${string}`
      | undefined;

    expect(browserTabId).toBeTruthy();

    useRightPanelTabsStore.setState({
      activeKind: "files",
      activeTabId: "files",
      openTabs: [browserTabId ?? "browser", "files"],
      rightPanelOpen: true,
    });

    toggleBrowserPanel();

    expect(useBrowserPanelStore.getState().open).toBe(true);
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      activeTabId: browserTabId,
      openTabs: [browserTabId ?? "browser", "files"],
      rightPanelOpen: true,
    });
  });

  it("closes the browser only when toggling the active browser tab", () => {
    toggleBrowserPanel();
    expect(useBrowserPanelStore.getState().open).toBe(true);

    toggleBrowserPanel();
    expect(useBrowserPanelStore.getState().open).toBe(false);
    expect(countRightPanelTabsByKind(useRightPanelTabsStore.getState().openTabs, "browser")).toBe(
      0,
    );
  });

  it("closes the browser panel without mutating the current URL", () => {
    openBrowserPanel({ url: "https://example.com" });
    openNewBrowserTab({ url: "https://bigbud.dev" });

    closeBrowserPanel();

    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: false,
      tabsById: {},
    });
    expect(getRequestedRightPanel()).toBeNull();
  });

  it("asks before closing an agent-controlled browser tab", () => {
    openBrowserPanel({ url: "https://example.com" });
    const tabId = Object.keys(useBrowserPanelStore.getState().tabsById)[0] as `browser:${string}`;
    useBrowserPanelStore.getState().setAgentLease(tabId, {
      leaseId: "lease:1",
      threadId: "thread:1",
      turnId: "turn:1",
    });

    closeBrowserTab(tabId);

    expect(useRightPanelTabsStore.getState().openTabs).toContain(tabId);
    expect(useBrowserPanelStore.getState().tabsById[tabId]?.agentLease).toBeDefined();
    expect(useBrowserCloseConfirmationStore.getState().tabIds).toEqual([tabId]);
  });

  it("opens a new browser tab without mutating the current browser tab", () => {
    openBrowserPanel({ url: "https://example.com" });
    const firstTabId = Object.keys(useBrowserPanelStore.getState().tabsById)[0] ?? "";

    openNewBrowserTab({ url: "https://bigbud.dev" });

    const { activeTabId, openTabs } = useRightPanelTabsStore.getState();
    const tabsById = useBrowserPanelStore.getState().tabsById;

    expect(openTabs).toHaveLength(2);
    expect(tabsById[firstTabId]?.url).toBe("https://example.com");
    expect(activeTabId).not.toBe(firstTabId);
    expect(activeTabId ? tabsById[activeTabId]?.url : null).toBe("https://bigbud.dev");
  });

  it("caps browser tabs at five", () => {
    for (let index = 0; index < MAX_RIGHT_PANEL_BROWSER_TABS; index += 1) {
      openNewBrowserTab({ url: `https://example.com/${index}` });
    }

    openNewBrowserTab({ url: "https://example.com/overflow" });

    expect(countRightPanelTabsByKind(useRightPanelTabsStore.getState().openTabs, "browser")).toBe(
      MAX_RIGHT_PANEL_BROWSER_TABS,
    );
  });
});
