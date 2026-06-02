import { afterEach, describe, expect, it, vi } from "vitest";

import { closeBrowserPanel, openBrowserPanel, toggleBrowserPanel } from "./browserPanel.actions";
import { useBrowserPanelStore } from "./browser.store";
import { useFilesPanelStore } from "../files/filesPanel.store";
import {
  getRequestedRightPanel,
  registerDiffPanelCloseAction,
  requestRightPanel,
} from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";

describe("browserPanel.actions", () => {
  afterEach(() => {
    useBrowserPanelStore.setState({ open: false, url: "" });
    useFilesPanelStore.setState({ open: false });
    useRightPanelTabsStore.setState({ activeKind: null, openTabs: [] });
    registerDiffPanelCloseAction(null);
    requestRightPanel(null);
  });

  it("closes the diff panel before opening the browser with a URL", () => {
    const closeDiff = vi.fn();
    registerDiffPanelCloseAction(closeDiff);

    openBrowserPanel({ url: " https://example.com/path " });

    expect(closeDiff).toHaveBeenCalledTimes(1);
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

  it("only closes the diff panel when toggling the browser open", () => {
    const closeDiff = vi.fn();
    registerDiffPanelCloseAction(closeDiff);

    toggleBrowserPanel();
    expect(closeDiff).toHaveBeenCalledTimes(1);
    expect(useBrowserPanelStore.getState().open).toBe(true);

    toggleBrowserPanel();
    expect(closeDiff).toHaveBeenCalledTimes(1);
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
