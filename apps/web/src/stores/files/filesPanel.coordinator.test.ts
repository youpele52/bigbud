import { afterEach, describe, expect, it, vi } from "vitest";

import { closeFilesPanel, toggleFilesPanel } from "./filesPanel.coordinator";
import { useFilesPanelStore } from "./filesPanel.store";
import { useBrowserPanelStore } from "../browser/browser.store";
import {
  getRequestedRightPanel,
  registerDiffPanelCloseAction,
  requestRightPanel,
} from "../rightPanel/rightPanel.coordinator";

describe("filesPanel.coordinator", () => {
  afterEach(() => {
    useFilesPanelStore.setState({ open: false });
    useBrowserPanelStore.setState({ open: false });
    registerDiffPanelCloseAction(null);
    requestRightPanel(null);
  });

  it("closes the diff panel and browser panel when toggling files open", () => {
    const closeDiff = vi.fn();
    registerDiffPanelCloseAction(closeDiff);
    useBrowserPanelStore.setState({ open: true });

    toggleFilesPanel();

    expect(closeDiff).toHaveBeenCalledTimes(1);
    expect(useBrowserPanelStore.getState().open).toBe(false);
    expect(useFilesPanelStore.getState().open).toBe(true);
    expect(getRequestedRightPanel()).toBe("files");
  });

  it("does not invoke the diff close action when toggling files closed", () => {
    useFilesPanelStore.setState({ open: true });
    requestRightPanel("files");
    const closeDiff = vi.fn();
    registerDiffPanelCloseAction(closeDiff);

    toggleFilesPanel();

    expect(closeDiff).not.toHaveBeenCalled();
    expect(useFilesPanelStore.getState().open).toBe(false);
    expect(getRequestedRightPanel()).toBeNull();
  });

  it("closeFilesPanel clears the requested right panel", () => {
    useFilesPanelStore.setState({ open: true });
    requestRightPanel("files");

    closeFilesPanel();

    expect(useFilesPanelStore.getState().open).toBe(false);
    expect(getRequestedRightPanel()).toBeNull();
  });
});
