import { beforeEach, describe, expect, it, vi } from "vitest";

const { copyTextToClipboard, openPathInPreferredApp, showContextMenu } = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
  openPathInPreferredApp: vi.fn().mockResolvedValue(undefined),
  showContextMenu: vi.fn(),
}));

vi.mock("~/lib/clipboard/copyText", () => ({
  copyTextToClipboard,
}));

vi.mock("~/models/editor/fileOpen.models", () => ({
  openPathInPreferredApp,
}));

vi.mock("~/rpc/nativeApi", () => ({
  ensureNativeApi: () => ({
    contextMenu: {
      show: showContextMenu,
    },
  }),
}));

import {
  createFilePreviewContextMenuItems,
  runFilePreviewContextMenuAction,
  showFilePreviewContextMenu,
} from "./FilePreview.contextMenu";

describe("FilePreview.contextMenu", () => {
  beforeEach(() => {
    copyTextToClipboard.mockClear();
    openPathInPreferredApp.mockClear();
    showContextMenu.mockReset();
  });

  it("builds preview menu items with text and annotation actions when available", () => {
    expect(
      createFilePreviewContextMenuItems({
        hasSelectedText: true,
        canSelectAll: true,
        canAnnotateSelection: true,
      }),
    ).toEqual([
      { id: "copy-selected-text", label: "Copy" },
      { id: "select-all", label: "Select All" },
      { id: "open-externally", label: "Open externally" },
      { id: "copy-relative-path", label: "Copy relative path" },
      { id: "copy-path", label: "Copy path" },
      { id: "annotate-selection", label: "Annotate selection" },
    ]);
  });

  it("copies the relative path when requested", async () => {
    await runFilePreviewContextMenuAction({
      action: "copy-relative-path",
      absolutePath: "/workspace/docs/guide.md",
      relativePath: "docs/guide.md",
      selectedText: "",
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith("docs/guide.md");
    expect(openPathInPreferredApp).not.toHaveBeenCalled();
  });

  it("opens the file externally when requested", async () => {
    await runFilePreviewContextMenuAction({
      action: "open-externally",
      absolutePath: "/workspace/docs/guide.md",
      relativePath: "docs/guide.md",
      selectedText: "",
    });

    expect(openPathInPreferredApp).toHaveBeenCalledWith(
      expect.objectContaining({
        contextMenu: expect.objectContaining({
          show: showContextMenu,
        }),
      }),
      "/workspace/docs/guide.md",
    );
  });

  it("shows the menu and dispatches the selected action", async () => {
    const onAnnotateSelection = vi.fn();
    showContextMenu.mockResolvedValue("annotate-selection");

    await showFilePreviewContextMenu({
      position: { x: 12, y: 18 },
      absolutePath: "/workspace/docs/guide.md",
      relativePath: "docs/guide.md",
      selectedText: "guide",
      canSelectAll: true,
      onAnnotateSelection,
    });

    expect(showContextMenu).toHaveBeenCalledWith(
      [
        { id: "copy-selected-text", label: "Copy" },
        { id: "select-all", label: "Select All" },
        { id: "open-externally", label: "Open externally" },
        { id: "copy-relative-path", label: "Copy relative path" },
        { id: "copy-path", label: "Copy path" },
        { id: "annotate-selection", label: "Annotate selection" },
      ],
      { x: 12, y: 18 },
    );
    expect(onAnnotateSelection).toHaveBeenCalledTimes(1);
  });
});
