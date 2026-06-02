import { afterEach, describe, expect, it, vi } from "vitest";

import { closeFilesPanel, toggleFilesPanel } from "./filesPanel.coordinator";
import { useFilesPanelStore } from "./filesPanel.store";
import { useBrowserPanelStore } from "../browser/browser.store";
import {
  getRequestedRightPanel,
  registerDiffPanelCloseAction,
  requestRightPanel,
} from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";

describe("filesPanel.coordinator", () => {
  afterEach(() => {
    useFilesPanelStore.setState({ open: false });
    useBrowserPanelStore.setState({ open: false });
    useRightPanelTabsStore.setState({ activeKind: null, openTabs: [] });
    registerDiffPanelCloseAction(null);
    requestRightPanel(null);
  });

  it("closes the diff panel and switches the active panel to files", () => {
    const closeDiff = vi.fn();
    registerDiffPanelCloseAction(closeDiff);
    useBrowserPanelStore.setState({ open: true });
    useRightPanelTabsStore.setState({ activeKind: "browser", openTabs: ["browser"] });

    toggleFilesPanel();

    expect(closeDiff).toHaveBeenCalledTimes(1);
    expect(useBrowserPanelStore.getState().open).toBe(true);
    expect(useFilesPanelStore.getState().open).toBe(true);
    expect(getRequestedRightPanel()).toBe("files");
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      openTabs: ["browser", "files"],
    });
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
    useRightPanelTabsStore.setState({ activeKind: "files", openTabs: ["files"] });

    closeFilesPanel();

    expect(useFilesPanelStore.getState().open).toBe(false);
    expect(getRequestedRightPanel()).toBeNull();
  });
});
