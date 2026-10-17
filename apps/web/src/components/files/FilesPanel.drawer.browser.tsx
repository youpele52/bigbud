import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

import { FILES_TREE_WIDTH_STORAGE_KEY } from "./FilesPanel.shared";
import {
  button,
  DrawerHarness,
  escape,
  filesHandle,
  hover,
  previewRegion,
  treeRegion,
  treeScroll,
} from "./FilesPanel.drawer.fixtures";

describe("FilesPanel tree drawer", () => {
  beforeEach(() => {
    localStorage.removeItem(FILES_TREE_WIDTH_STORAGE_KEY);
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem(FILES_TREE_WIDTH_STORAGE_KEY);
  });

  async function advance(milliseconds: number) {
    await vi.advanceTimersByTimeAsync(milliseconds);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  it("shows the full tree without a preview, then hides it without replacing its scroll DOM", async () => {
    const mounted = await render(<DrawerHarness />);
    try {
      const scroll = treeScroll();
      expect(treeRegion().getBoundingClientRect().width).toBe(900);
      expect(treeRegion().getAttribute("aria-hidden")).toBe("false");
      scroll.scrollTop = 250;
      button("file-15.ts").focus();
      button("file-15.ts").click();
      await vi.waitFor(() => expect(treeRegion().getAttribute("aria-hidden")).toBe("true"));
      expect(treeRegion().inert).toBe(true);
      expect(treeScroll()).toBe(scroll);
      expect(treeScroll().scrollTop).toBe(250);
      expect(previewRegion().getBoundingClientRect().width).toBe(900);
      expect(filesHandle().getAttribute("aria-expanded")).toBe("false");
      expect(treeRegion().contains(document.activeElement)).toBe(false);

      button("Close file").click();
      await vi.waitFor(() => expect(treeRegion().getAttribute("aria-hidden")).toBe("false"));
      expect(treeScroll()).toBe(scroll);
      expect(button("readme.md")).toBeTruthy();
      expect(treeRegion().getBoundingClientRect().width).toBe(900);
    } finally {
      await mounted.unmount();
    }
  });

  it("opens after 250ms without reflowing, remounting, or scrolling preview; closes with grace and cancellation", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const content = document.querySelector<HTMLDivElement>("[data-preview-content]")!;
      content.scrollTop = 180;
      const previewBounds = previewRegion().getBoundingClientRect();
      hover(filesHandle(), true);
      await advance(249);
      expect(treeRegion().getAttribute("aria-hidden")).toBe("true");
      await advance(1);
      expect(treeRegion().getAttribute("aria-hidden")).toBe("false");
      expect(treeRegion().getBoundingClientRect().width).toBeCloseTo(300, 0);
      expect(previewRegion().getBoundingClientRect().width).toBe(previewBounds.width);
      expect(document.querySelector("[data-preview-content]")).toBe(content);
      expect(content.scrollTop).toBe(180);

      hover(filesHandle(), false);
      hover(treeRegion(), true);
      await advance(1100);
      expect(treeRegion().getAttribute("aria-hidden")).toBe("false");
      hover(treeRegion(), false);
      await advance(999);
      expect(treeRegion().getAttribute("aria-hidden")).toBe("false");
      hover(treeRegion(), true);
      await advance(1100);
      expect(treeRegion().getAttribute("aria-hidden")).toBe("false");
      hover(treeRegion(), false);
      await advance(1000);
      expect(treeRegion().getAttribute("aria-hidden")).toBe("true");
      hover(filesHandle(), true);
      await advance(250);
      escape(document.body);
      await advance(0);
      expect(treeRegion().inert).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it("supports click and keyboard opening, browsing without dismissal, Escape focus return, and pinning", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      filesHandle().focus();
      filesHandle().dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(treeRegion().contains(document.activeElement)).toBe(true));
      button("file-2.ts").focus();
      button("file-2.ts").click();
      await vi.waitFor(() =>
        expect(document.querySelector("[data-preview-content]")?.textContent).toContain(
          "file-2.ts",
        ),
      );
      expect(document.activeElement).toBe(button("file-2.ts"));
      expect(treeRegion().getAttribute("aria-hidden")).toBe("false");
      button("file-3.ts").click();
      expect(treeRegion().getAttribute("aria-hidden")).toBe("false");
      escape(button("file-2.ts"));
      await vi.waitFor(() => expect(treeRegion().inert).toBe(true));
      await vi.waitFor(() => expect(document.activeElement).toBe(filesHandle()));
      filesHandle().focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(treeRegion().inert).toBe(false));
      const scroll = treeScroll();
      scroll.scrollTop = 170;
      button("Keep tree beside file").click();
      await vi.waitFor(() => expect(document.querySelector('[role="separator"]')).not.toBeNull());
      expect(previewRegion().getBoundingClientRect().width).toBeLessThan(900);
      expect(treeScroll()).toBe(scroll);
      expect(scroll.scrollTop).toBe(170);
      button("Unpin file tree").click();
      await vi.waitFor(() => expect(document.querySelector('[role="separator"]')).toBeNull());
      expect(previewRegion().getBoundingClientRect().width).toBe(900);
      expect(treeRegion().getAttribute("aria-hidden")).toBe("false");
      filesHandle().click();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(true));
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the right-aligned top-header icon stationary and clickable after hover", async () => {
    await page.viewport(1000, 700);
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const handle = filesHandle();
      const bounds = handle.getBoundingClientRect();
      const header = document.querySelector<HTMLElement>("[data-files-panel-header]")!;
      expect(handle.closest("[data-files-panel-header]")).toBe(header);
      expect(previewRegion().contains(handle)).toBe(false);
      expect(handle.textContent).toBe("");
      expect(handle.querySelector("svg")).not.toBeNull();
      expect(bounds.right).toBeGreaterThan(header.getBoundingClientRect().right - 20);
      expect(bounds.bottom).toBeLessThanOrEqual(header.getBoundingClientRect().bottom);
      hover(handle, true);
      await advance(250);
      expect(filesHandle()).toBe(handle);
      expect(handle.getBoundingClientRect().top).toBe(bounds.top);
      expect(document.elementFromPoint(bounds.x + 10, bounds.y + 10)?.closest("button")).toBe(
        handle,
      );
      handle.click();
      await advance(0);
      expect(treeRegion().inert).toBe(true);
      hover(handle, true);
      await advance(2000);
      expect(treeRegion().inert).toBe(true);
      hover(handle, false);
      hover(handle, true);
      await advance(250);
      expect(treeRegion().inert).toBe(false);
      handle.click();
      await advance(0);
      expect(treeRegion().inert).toBe(true);
      handle.click(); // explicit click opens persistently, even while hover is suppressed
      await advance(0);
      previewRegion().focus();
      hover(handle, false);
      await advance(2000);
      expect(treeRegion().inert).toBe(false);
      escape(previewRegion());
      await advance(0);
      expect(treeRegion().inert).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it("holds transient drawers for keyboard focus, portalled menus, and dragging", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      hover(filesHandle(), true);
      await advance(250);
      button("file-1.ts").focus();
      button("file-1.ts").click();
      await advance(0);
      expect(document.querySelector("[data-preview-content]")?.textContent).toContain("file-1.ts");
      hover(filesHandle(), false);
      await advance(2000);
      expect(treeRegion().inert).toBe(false);
      await mounted.rerender(<DrawerHarness initialPreview="docs/readme.md" contextMenuOpen />);
      previewRegion().focus();
      await advance(2000);
      escape(previewRegion());
      await advance(0);
      expect(treeRegion().inert).toBe(false);
      await mounted.rerender(<DrawerHarness initialPreview="docs/readme.md" />);
      button("file-1.ts").dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }),
      );
      await advance(2000);
      expect(treeRegion().inert).toBe(false);
      window.dispatchEvent(new Event("dragend"));
      await advance(1000);
      expect(treeRegion().inert).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it("constrains widths responsively and reuses saved split resizing", async () => {
    localStorage.setItem(FILES_TREE_WIDTH_STORAGE_KEY, "320");
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" width={500} />);
    try {
      filesHandle().click();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(false));
      expect(treeRegion().getBoundingClientRect().width).toBe(220);
      button("Keep tree beside file").click();
      await vi.waitFor(() => expect(document.querySelector('[role="separator"]')).not.toBeNull());
      const separator = document.querySelector<HTMLElement>('[role="separator"]')!;
      expect(treeRegion().getBoundingClientRect().width).toBeLessThanOrEqual(300);
      expect(previewRegion().getBoundingClientRect().width).toBeGreaterThan(190);
      separator.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() =>
        expect(localStorage.getItem(FILES_TREE_WIDTH_STORAGE_KEY)).toBe("220"),
      );
      button("Unpin file tree").click();
      await mounted.rerender(<DrawerHarness initialPreview="docs/readme.md" width={180} />);
      expect(treeRegion().getBoundingClientRect().width).toBe(180);
      expect(previewRegion().getBoundingClientRect().width).toBe(180);
    } finally {
      await mounted.unmount();
    }
  });
});
