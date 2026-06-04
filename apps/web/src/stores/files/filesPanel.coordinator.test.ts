import { afterEach, describe, expect, it } from "vitest";

import { closeFilesPanel, toggleFilesPanel } from "./filesPanel.coordinator";
import { useFilesPanelStore } from "./filesPanel.store";
import { useBrowserPanelStore } from "../browser/browser.store";
import { getRequestedRightPanel, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";

describe("filesPanel.coordinator", () => {
  afterEach(() => {
    useFilesPanelStore.setState({
      open: false,
      previewPath: null,
      previewPosition: null,
      fileOpenRequest: null,
      directoryNavigationRequest: null,
    });
    useBrowserPanelStore.setState({ open: false });
    useRightPanelTabsStore.setState({ activeKind: null, openTabs: [], rightPanelOpen: false });
    requestRightPanel(null);
  });

  it("keeps other tabs open and switches the active tab to files", () => {
    useBrowserPanelStore.setState({ open: true });
    useRightPanelTabsStore.setState({ activeKind: "browser", openTabs: ["browser"] });

    toggleFilesPanel();

    expect(useBrowserPanelStore.getState().open).toBe(true);
    expect(useFilesPanelStore.getState().open).toBe(true);
    expect(getRequestedRightPanel()).toBe("files");
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      openTabs: ["browser", "files"],
    });
  });

  it("activates files instead of closing them when the tab is already open in the background", () => {
    useFilesPanelStore.setState({ open: true });
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      openTabs: ["files", "browser"],
      rightPanelOpen: true,
    });

    toggleFilesPanel();

    expect(useFilesPanelStore.getState().open).toBe(true);
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      openTabs: ["files", "browser"],
      rightPanelOpen: true,
    });
  });

  it("closes files only when toggling the active files tab", () => {
    useFilesPanelStore.setState({ open: true });
    requestRightPanel("files");
    useRightPanelTabsStore.setState({
      activeKind: "files",
      openTabs: ["files"],
      rightPanelOpen: true,
    });

    toggleFilesPanel();

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
