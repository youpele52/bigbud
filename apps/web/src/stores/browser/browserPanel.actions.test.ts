import { afterEach, describe, expect, it, vi } from "vitest";

import { closeBrowserPanel, openBrowserPanel, toggleBrowserPanel } from "./browserPanel.actions";
import { useBrowserPanelStore } from "./browser.store";
import { useFilesPanelStore } from "../files/filesPanel.store";
import {
  getRequestedRightPanel,
  registerDiffPanelCloseAction,
  requestRightPanel,
} from "../rightPanel/rightPanel.coordinator";

describe("browserPanel.actions", () => {
  afterEach(() => {
    useBrowserPanelStore.setState({ open: false, url: "" });
    useFilesPanelStore.setState({ open: false });
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

  it("closes the files panel when opening the browser", () => {
    useFilesPanelStore.setState({ open: true });
    requestRightPanel("files");

    openBrowserPanel({ url: "https://example.com" });

    expect(useFilesPanelStore.getState().open).toBe(false);
    expect(useBrowserPanelStore.getState().open).toBe(true);
    expect(getRequestedRightPanel()).toBe("browser");
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
