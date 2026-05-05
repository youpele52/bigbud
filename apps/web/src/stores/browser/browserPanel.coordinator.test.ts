import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeBrowserPanel,
  getRequestedRightPanel,
  openBrowserPanel,
  registerDiffPanelCloseAction,
  requestRightPanel,
  toggleBrowserPanel,
} from "./browserPanel.coordinator";
import { useBrowserPanelStore } from "./browser.store";

describe("browserPanel.coordinator", () => {
  afterEach(() => {
    useBrowserPanelStore.setState({ open: false, url: "" });
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
