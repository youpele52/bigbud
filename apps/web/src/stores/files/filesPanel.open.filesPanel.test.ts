import { describe, expect, it } from "vitest";

import { useBrowserPanelStore } from "../browser/browser.store";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";
import {
  openDirectoryInFilesPanelIfSupported,
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

describe("openPathInFilesPanelIfSupported", () => {
  it("opens the files tab with the parsed preview position", () => {
    resetFilesPanelState();

    expect(
      openPathInFilesPanelIfSupported(
        "/Users/alice/project/src/index.ts:16:23",
        "/Users/alice/project",
      ),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/project",
      fileOpenRequest: {
        path: "src/index.ts",
        position: { line: 16, column: 23 },
        workspaceRootOverride: "/Users/alice/project",
        requestId: 1,
      },
    });
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      openTabs: ["files"],
    });
  });

  it("clears any previous preview position when opening a plain file path", () => {
    resetFilesPanelState();
    useFilesPanelStore.setState({
      open: true,
      workspaceRootOverride: null,
      previewPath: "src/old.ts",
      previewPosition: { line: 9, column: 2 },
      fileOpenRequest: null,
    });

    expect(
      openPathInFilesPanelIfSupported("/Users/alice/project/src/new.ts", "/Users/alice/project"),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      fileOpenRequest: {
        path: "src/new.ts",
        position: null,
        workspaceRootOverride: "/Users/alice/project",
        requestId: 1,
      },
    });
  });

  it("opens workspace images in the files panel", () => {
    resetFilesPanelState();

    expect(
      openPathInFilesPanelIfSupported(
        "/Users/alice/project/assets/logo.png",
        "/Users/alice/project",
      ),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/project",
      fileOpenRequest: {
        path: "assets/logo.png",
        position: null,
        workspaceRootOverride: "/Users/alice/project",
        requestId: 1,
      },
    });
  });

  it("opens workspace videos in the files panel", () => {
    resetFilesPanelState();

    expect(
      openPathInFilesPanelIfSupported(
        "/Users/alice/project/assets/demo.mp4",
        "/Users/alice/project",
      ),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/project",
      fileOpenRequest: {
        path: "assets/demo.mp4",
        position: null,
        workspaceRootOverride: "/Users/alice/project",
        requestId: 1,
      },
    });
  });

  it("opens workspace html files in the files panel", () => {
    resetFilesPanelState();

    expect(
      openPathInFilesPanelIfSupported(
        "/Users/alice/project/public/index.html",
        "/Users/alice/project",
      ),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/project",
      fileOpenRequest: {
        path: "public/index.html",
        position: null,
        workspaceRootOverride: "/Users/alice/project",
        requestId: 1,
      },
    });
  });
});

describe("openDirectoryInFilesPanelIfSupported", () => {
  it("opens the files tab and requests directory navigation", () => {
    resetFilesPanelState();

    expect(
      openDirectoryInFilesPanelIfSupported("/Users/alice/project/src/lib", "/Users/alice/project"),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      open: true,
      workspaceRootOverride: "/Users/alice/project",
      previewPath: null,
      previewPosition: null,
      fileOpenRequest: null,
      directoryNavigationRequest: {
        path: "src/lib",
        workspaceRootOverride: "/Users/alice/project",
        requestId: 1,
      },
    });
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      openTabs: ["files"],
    });
  });
});
