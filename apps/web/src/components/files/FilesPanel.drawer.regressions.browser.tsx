import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { FILES_TREE_WIDTH_STORAGE_KEY } from "./FilesPanel.shared";
import {
  button,
  DrawerHarness,
  escape,
  filesHandle,
  treeRegion,
  treeScroll,
} from "./FilesPanel.drawer.fixtures";

function keyboardOpen() {
  filesHandle().focus();
  filesHandle().dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    }),
  );
}

function isVisibleInScroll(row: HTMLElement) {
  const scroll = treeScroll();
  const bounds = scroll.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  return rowBounds.top >= bounds.top && rowBounds.bottom <= bounds.top + scroll.clientHeight;
}

function resizeKey(separator: HTMLElement, key: string) {
  separator.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function rowContentTop(row: HTMLElement) {
  const scroll = treeScroll();
  return row.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
}

describe("files drawer review regressions", () => {
  beforeEach(() => localStorage.removeItem(FILES_TREE_WIDTH_STORAGE_KEY));
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(FILES_TREE_WIDTH_STORAGE_KEY);
  });

  it.each(["pointer", "keyboard"] as const)(
    "moves the rendered separator on the first %s step from a capped saved width and after panel resizing",
    async (input) => {
      localStorage.setItem(FILES_TREE_WIDTH_STORAGE_KEY, "500");
      const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" width={900} />);
      try {
        keyboardOpen();
        await vi.waitFor(() => expect(treeRegion().inert).toBe(false));
        button("Keep tree beside file").click();
        await vi.waitFor(() => expect(treeRegion().getBoundingClientRect().width).toBe(445));
        const separator = document.querySelector<HTMLElement>('[role="separator"]')!;
        expect(separator.getAttribute("aria-valuenow")).toBe("445");
        expect(separator.getAttribute("aria-valuemax")).toBe("445");
        const originalX = separator.getBoundingClientRect().left;
        if (input === "pointer") {
          // Synthetic events cannot establish browser pointer capture. Stub only that
          // native call; exercise the actual handlers and rendered separator movement.
          vi.spyOn(separator, "setPointerCapture").mockImplementation(() => {});
          separator.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              pointerId: 7,
              button: 0,
              clientX: originalX,
            }),
          );
          separator.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              pointerId: 7,
              clientX: originalX + 20,
            }),
          );
        } else {
          resizeKey(separator, "ArrowRight");
        }
        await vi.waitFor(() => expect(treeRegion().getBoundingClientRect().width).toBe(425));
        expect(separator.getBoundingClientRect().left).toBe(originalX + 20);
        expect(separator.getAttribute("aria-valuenow")).toBe("425");
        separator.dispatchEvent(
          new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 7 }),
        );

        resizeKey(separator, "ArrowRight");
        await vi.waitFor(() => expect(treeRegion().getBoundingClientRect().width).toBe(405));
        expect(separator.getBoundingClientRect().left).toBe(originalX + 40);
        resizeKey(separator, "ArrowLeft");
        await vi.waitFor(() => expect(treeRegion().getBoundingClientRect().width).toBe(425));

        await mounted.rerender(<DrawerHarness initialPreview="docs/readme.md" width={700} />);
        await vi.waitFor(() => expect(treeRegion().getBoundingClientRect().width).toBe(245));
        expect(separator.getAttribute("aria-valuenow")).toBe("245");
        expect(separator.getAttribute("aria-valuemax")).toBe("245");
        const resizedX = separator.getBoundingClientRect().left;
        resizeKey(separator, "ArrowRight");
        await vi.waitFor(() => expect(treeRegion().getBoundingClientRect().width).toBe(225));
        expect(separator.getBoundingClientRect().left).toBe(resizedX + 20);
        expect(separator.getAttribute("aria-valuenow")).toBe("225");
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("reopens on a visible selected row, retains the last visible row, and falls back to a visible control without scrolling", async () => {
    const mounted = await render(<DrawerHarness initialPreview="file-20.ts" />);
    try {
      keyboardOpen();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(false));
      const scroll = treeScroll();
      const selected = button("file-20.ts");
      scroll.scrollTop = rowContentTop(selected) - scroll.clientHeight / 2;
      expect(scroll.scrollTop).toBeGreaterThan(0);
      expect(isVisibleInScroll(selected)).toBe(true);
      selected.focus({ preventScroll: true });
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(document.activeElement).toBe(filesHandle()));
      const retainedScroll = scroll.scrollTop;
      keyboardOpen();
      await vi.waitFor(() => expect(document.activeElement).toBe(selected));
      expect(isVisibleInScroll(selected)).toBe(true);
      expect(scroll.scrollTop).toBe(retainedScroll);

      // Keep a non-selected focused row visible while the selected row is offscreen.
      const lastFocused = button("file-40.ts");
      scroll.scrollTop = rowContentTop(lastFocused) - scroll.clientHeight / 2;
      const lastFocusedScroll = scroll.scrollTop;
      expect(isVisibleInScroll(selected)).toBe(false);
      expect(isVisibleInScroll(lastFocused)).toBe(true);
      lastFocused.focus({ preventScroll: true });
      escape(lastFocused);
      await vi.waitFor(() => expect(document.activeElement).toBe(filesHandle()));
      keyboardOpen();
      await vi.waitFor(() => expect(document.activeElement).toBe(lastFocused));
      expect(scroll.scrollTop).toBe(lastFocusedScroll);

      // Neither remembered row is visible here: focus the always-visible toolbar.
      escape(lastFocused);
      await vi.waitFor(() => expect(document.activeElement).toBe(filesHandle()));
      scroll.scrollTop = Math.max(1, rowContentTop(selected) - scroll.clientHeight - 50);
      const fallbackScroll = scroll.scrollTop;
      expect(fallbackScroll).toBeGreaterThan(0);
      expect(isVisibleInScroll(selected)).toBe(false);
      expect(isVisibleInScroll(lastFocused)).toBe(false);
      keyboardOpen();
      await vi.waitFor(() => expect(document.activeElement).toBe(filesHandle()));
      expect(scroll.scrollTop).toBe(fallbackScroll);
      const controlBounds = filesHandle().getBoundingClientRect();
      const headerBounds = document
        .querySelector<HTMLElement>("[data-files-panel-header]")!
        .getBoundingClientRect();
      expect(controlBounds.top).toBeGreaterThanOrEqual(headerBounds.top);
      expect(controlBounds.bottom).toBeLessThanOrEqual(headerBounds.bottom);
    } finally {
      await mounted.unmount();
    }
  });
});
