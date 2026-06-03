import { afterEach, describe, expect, it } from "vitest";

import { closeBrowserPanel, openBrowserPanel, toggleBrowserPanel } from "./browserPanel.actions";
import { useBrowserPanelStore } from "./browser.store";
import { useFilesPanelStore } from "../files/filesPanel.store";
import { getRequestedRightPanel, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";

describe("browserPanel.actions", () => {
  afterEach(() => {
    useBrowserPanelStore.setState({ open: false, url: "" });
    useFilesPanelStore.setState({ open: false });
    useRightPanelTabsStore.setState({ activeKind: null, openTabs: [], rightPanelOpen: false });
    requestRightPanel(null);
  });

  it("opens the browser with a normalized URL", () => {
    openBrowserPanel({ url: " https://example.com/path " });

    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: true,
      url: "https://example.com/path",
    });
  });

  it("keeps the files tab open while switching the active panel to browser", () => {
    useFilesPanelStore.setState({ open: true });
    requestRightPanel("files");
    useRightPanelTabsStore.setState({ activeKind: "files", openTabs: ["files"] });

    openBrowserPanel({ url: "https://example.com" });

    expect(useFilesPanelStore.getState().open).toBe(true);
    expect(useBrowserPanelStore.getState().open).toBe(true);
    expect(getRequestedRightPanel()).toBe("browser");
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      openTabs: ["files", "browser"],
    });
  });

  it("activates the browser instead of closing it when the tab is already open in the background", () => {
    useBrowserPanelStore.setState({ open: true, url: "https://example.com" });
    useRightPanelTabsStore.setState({
      activeKind: "files",
      openTabs: ["browser", "files"],
      rightPanelOpen: true,
    });

    toggleBrowserPanel();

    expect(useBrowserPanelStore.getState().open).toBe(true);
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      openTabs: ["browser", "files"],
      rightPanelOpen: true,
    });
  });

  it("closes the browser only when toggling the active browser tab", () => {
    toggleBrowserPanel();
    expect(useBrowserPanelStore.getState().open).toBe(true);

    toggleBrowserPanel();
    expect(useBrowserPanelStore.getState().open).toBe(false);
  });

  it("closes the browser panel without mutating the current URL", () => {
    useBrowserPanelStore.setState({ open: true, url: "https://example.com" });
    requestRightPanel("browser");

    closeBrowserPanel();

    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: false,
      url: "https://example.com",
    });
    expect(getRequestedRightPanel()).toBeNull();
  });
});
