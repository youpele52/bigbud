import { describe, expect, it } from "vitest";

import { parsePathPositionSuffix } from "../../models/editor";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";
import {
  canOpenDirectoryInFilesPanel,
  canOpenPathInFilesPanel,
  openDirectoryInFilesPanelIfSupported,
  openPathInFilesPanelIfSupported,
  resolveWorkspaceRelativeEntryPath,
} from "./filesPanel.open";

function resetFilesPanelState() {
  useFilesPanelStore.setState({
    open: false,
    previewPath: null,
    previewPosition: null,
    fileOpenRequest: null,
    directoryNavigationRequest: null,
  });
  useRightPanelTabsStore.setState({ activeKind: null, activeTabId: null, openTabs: [] });
}

describe("parsePathPositionSuffix", () => {
  it("extracts line and column from a file path suffix", () => {
    expect(parsePathPositionSuffix("/Users/alice/project/src/index.ts:16:23")).toEqual({
      line: 16,
      column: 23,
    });
  });

  it("extracts line without a column", () => {
    expect(parsePathPositionSuffix("/Users/alice/project/src/index.ts:16")).toEqual({
      line: 16,
      column: null,
    });
  });

  it("returns null when no position suffix is present", () => {
    expect(parsePathPositionSuffix("/Users/alice/project/src/index.ts")).toBeNull();
  });
});

describe("resolveWorkspaceRelativeEntryPath", () => {
  it("maps a workspace file path to a relative preview path", () => {
    expect(
      resolveWorkspaceRelativeEntryPath(
        "/Users/alice/project/src/index.ts",
        "/Users/alice/project",
      ),
    ).toBe("src/index.ts");
  });

  it("strips line and column suffixes before opening in the viewer", () => {
    expect(
      resolveWorkspaceRelativeEntryPath(
        "/Users/alice/project/src/index.ts:16:23",
        "/Users/alice/project",
      ),
    ).toBe("src/index.ts");
  });

  it("rejects files outside the current workspace", () => {
    expect(
      resolveWorkspaceRelativeEntryPath(
        "/Users/alice/other-project/src/index.ts",
        "/Users/alice/project",
      ),
    ).toBeNull();
  });

  it("handles windows paths case-insensitively", () => {
    expect(
      resolveWorkspaceRelativeEntryPath(
        "C:\\Users\\Alice\\Project\\src\\index.ts:8",
        "C:\\Users\\alice\\project",
      ),
    ).toBe("src/index.ts");
  });
});

describe("canOpenPathInFilesPanel", () => {
  it("allows previewable workspace files", () => {
    expect(canOpenPathInFilesPanel("/Users/alice/project/README.md", "/Users/alice/project")).toBe(
      true,
    );
  });

  it("rejects unsupported files even when they are in the workspace", () => {
    expect(canOpenPathInFilesPanel("/Users/alice/project/logo.png", "/Users/alice/project")).toBe(
      false,
    );
  });
});

describe("canOpenDirectoryInFilesPanel", () => {
  it("allows workspace directories", () => {
    expect(canOpenDirectoryInFilesPanel("/Users/alice/project/src", "/Users/alice/project")).toBe(
      true,
    );
  });

  it("rejects directories outside the workspace", () => {
    expect(canOpenDirectoryInFilesPanel("/Users/alice/other/src", "/Users/alice/project")).toBe(
      false,
    );
  });
});

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
      fileOpenRequest: {
        path: "src/index.ts",
        position: { line: 16, column: 23 },
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
      previewPath: null,
      previewPosition: null,
      fileOpenRequest: null,
      directoryNavigationRequest: {
        path: "src/lib",
        requestId: 1,
      },
    });
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "files",
      openTabs: ["files"],
    });
  });
});
