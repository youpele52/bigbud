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
    workspaceRootOverride: null,
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
      workspaceRootOverride: null,
      fileOpenRequest: {
        path: "README.md",
        position: null,
        workspaceRootOverride: null,
        requestId: 1,
      },
    });
    expect(Object.keys(useBrowserPanelStore.getState().tabsById)).toHaveLength(0);
  });

  it("opens supported files outside the current workspace inside the files panel", async () => {
    resetFilesPanelState();

    await openPathFromChat("/Users/alice/other-project/README.md", "/Users/alice/project");

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/other-project",
      fileOpenRequest: {
        path: "README.md",
        position: null,
        workspaceRootOverride: "/Users/alice/other-project",
        requestId: 1,
      },
    });
  });

  it("opens workspace directories in the files panel tree", async () => {
    resetFilesPanelState();

    await openPathFromChat(
      "/Users/alice/project/src/components",
      "/Users/alice/project",
      "directory",
    );

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: null,
      previewPath: null,
      directoryNavigationRequest: {
        path: "src/components",
        workspaceRootOverride: null,
        requestId: 1,
      },
    });
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });

  it("opens external directories by rooting the files panel to the target folder", async () => {
    resetFilesPanelState();

    await openPathFromChat("/Users/alice/other-project/docs", "/Users/alice/project", "directory");

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/other-project/docs",
      previewPath: null,
      directoryNavigationRequest: {
        path: "",
        workspaceRootOverride: "/Users/alice/other-project/docs",
        requestId: 1,
      },
    });
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });
});
