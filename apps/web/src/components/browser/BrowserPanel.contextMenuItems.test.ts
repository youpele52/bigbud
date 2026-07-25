import { describe, expect, it } from "vitest";

import { createBrowserContextMenuItems } from "./BrowserPanel.contextMenuItems";

const viewportRef = { current: null } as never;

function createItems(context?: Parameters<typeof createBrowserContextMenuItems>[0]["context"]) {
  return createBrowserContextMenuItems({
    canGoBack: true,
    canGoForward: false,
    context: context ?? null,
    currentUrl: "https://example.com/docs",
    activeThreadId: "thread-1" as never,
    viewportRef,
    onOpenNewTab: () => undefined,
  });
}

describe("createBrowserContextMenuItems", () => {
  it("includes page actions and safely rejects non-http URLs", () => {
    const items = createBrowserContextMenuItems({
      canGoBack: false,
      canGoForward: false,
      context: { x: 1, y: 2, pageURL: "javascript:alert(1)" },
      currentUrl: "https://example.com/docs",
      activeThreadId: null,
      viewportRef,
      onOpenNewTab: () => undefined,
    });

    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining(["back", "forward", "reload", "copy-page-url"]),
    );
    expect(items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(["view-source", "print"]),
    );
    expect(items.find((item) => item.id === "open-page-external")?.disabled).toBe(false);
  });

  it("adds selection and link actions only for matching context", () => {
    const items = createItems({
      x: 4,
      y: 5,
      pageURL: "https://example.com/docs",
      linkURL: "https://example.com/next",
      selectionText: "selected text",
    });

    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "copy-selection",
        "search-selection",
        "send-selection",
        "open-link",
        "open-link-external",
        "copy-link",
      ]),
    );
  });

  it("adds edit actions with Electron capability flags", () => {
    const items = createItems({
      x: 4,
      y: 5,
      isEditable: true,
      editFlags: {
        canUndo: false,
        canRedo: true,
        canCut: false,
        canCopy: true,
        canPaste: false,
        canSelectAll: true,
      },
    });

    expect(items.find((item) => item.id === "undo")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "redo")?.disabled).toBe(false);
    expect(items.find((item) => item.id === "paste")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "select-all")?.disabled).toBe(false);
  });
});
