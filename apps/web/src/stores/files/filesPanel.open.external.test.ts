import { describe, expect, it } from "vitest";

import { useBrowserPanelStore } from "../browser/browser.store";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";
import {
  canOpenDirectoryInFilesPanel,
  openDirectoryInFilesPanelIfSupported,
  openPathInBrowserPanelIfSupported,
  openPathInFilesPanelIfSupported,
} from "./filesPanel.open";

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

describe("filesPanel.open external paths", () => {
  it("allows directories outside the workspace", () => {
    expect(canOpenDirectoryInFilesPanel("/Users/alice/other/src", "/Users/alice/project")).toBe(
      true,
    );
  });

  it("opens html files outside the current workspace in the browser panel", () => {
    resetFilesPanelState();

    expect(
      openPathInBrowserPanelIfSupported(
        "/Users/alice/other-project/public/index.html",
        "/Users/alice/project",
      ),
    ).toBe(true);

    const browserTabIds = Object.keys(useBrowserPanelStore.getState().tabsById);
    expect(useBrowserPanelStore.getState().tabsById[browserTabIds[0] ?? ""]?.url).toContain(
      `cwd=${encodeURIComponent("/Users/alice/other-project/public")}`,
    );
  });

  it("opens files outside the current workspace with an override root", () => {
    resetFilesPanelState();

    expect(
      openPathInFilesPanelIfSupported(
        "/Users/alice/other-project/src/index.ts:9",
        "/Users/alice/project",
      ),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/other-project/src",
      fileOpenRequest: {
        path: "index.ts",
        position: { line: 9, column: null },
        workspaceRootOverride: "/Users/alice/other-project/src",
        requestId: 1,
      },
    });
  });

  it("opens external directories by rooting the files panel to that directory", () => {
    resetFilesPanelState();

    expect(
      openDirectoryInFilesPanelIfSupported(
        "/Users/alice/other-project/docs",
        "/Users/alice/project",
      ),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/other-project/docs",
      directoryNavigationRequest: {
        path: "",
        workspaceRootOverride: "/Users/alice/other-project/docs",
        requestId: 1,
      },
    });
  });
});
