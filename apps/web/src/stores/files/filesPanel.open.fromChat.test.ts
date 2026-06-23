import { describe, expect, it } from "vitest";

import { useBrowserPanelStore } from "../browser/browser.store";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";
import { openPathFromChat } from "./filesPanel.open";

function resetFilesPanelState() {
  useBrowserPanelStore.setState({
    open: false,
    tabsById: {},
  });
  useFilesPanelStore.setState({
    open: false,
    previewPath: null,
    previewPosition: null,
    fileOpenRequest: null,
    directoryNavigationRequest: null,
  });
  useRightPanelTabsStore.setState({ activeKind: null, activeTabId: null, openTabs: [] });
}

describe("openPathFromChat", () => {
  it("opens workspace html files in the browser panel before the file viewer", async () => {
    resetFilesPanelState();

    await openPathFromChat("/Users/alice/project/public/index.html", "/Users/alice/project");

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);
    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: true,
      tabsById: {
        [browserTabIds[0] ?? ""]: {
          url: expect.stringContaining("/api/workspace-file-preview?"),
        },
      },
    });
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });

  it("opens markdown files in the files panel when browser preview is unavailable", async () => {
    resetFilesPanelState();

    await openPathFromChat("/Users/alice/project/README.md", "/Users/alice/project");

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      fileOpenRequest: {
        path: "README.md",
        position: null,
        requestId: 1,
      },
    });
    expect(Object.keys(useBrowserPanelStore.getState().tabsById)).toHaveLength(0);
  });
});
