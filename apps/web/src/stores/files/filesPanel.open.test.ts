import { describe, expect, it } from "vitest";

import { parsePathPositionSuffix } from "../../models/editor";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";
import { useFilesPanelStore } from "./filesPanel.store";
import { canOpenPathInFilesPanel, resolveWorkspaceRelativePreviewPath } from "./filesPanel.open";
import { openPathInFilesPanelIfSupported } from "./filesPanel.open";

function resetFilesPanelState() {
  useFilesPanelStore.setState({
    open: false,
    previewPath: null,
    previewPosition: null,
  });
  useRightPanelTabsStore.setState({ activeKind: null, openTabs: [] });
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

describe("resolveWorkspaceRelativePreviewPath", () => {
  it("maps a workspace file path to a relative preview path", () => {
    expect(
      resolveWorkspaceRelativePreviewPath(
        "/Users/alice/project/src/index.ts",
        "/Users/alice/project",
      ),
    ).toBe("src/index.ts");
  });

  it("strips line and column suffixes before opening in the viewer", () => {
    expect(
      resolveWorkspaceRelativePreviewPath(
        "/Users/alice/project/src/index.ts:16:23",
        "/Users/alice/project",
      ),
    ).toBe("src/index.ts");
  });

  it("rejects files outside the current workspace", () => {
    expect(
      resolveWorkspaceRelativePreviewPath(
        "/Users/alice/other-project/src/index.ts",
        "/Users/alice/project",
      ),
    ).toBeNull();
  });

  it("handles windows paths case-insensitively", () => {
    expect(
      resolveWorkspaceRelativePreviewPath(
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
      previewPath: "src/index.ts",
      previewPosition: { line: 16, column: 23 },
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
    });

    expect(
      openPathInFilesPanelIfSupported("/Users/alice/project/src/new.ts", "/Users/alice/project"),
    ).toBe(true);

    expect(useFilesPanelStore.getState()).toMatchObject({
      previewPath: "src/new.ts",
      previewPosition: null,
    });
  });
});
