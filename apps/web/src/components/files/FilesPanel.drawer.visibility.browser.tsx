import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { FILES_TREE_WIDTH_STORAGE_KEY } from "./FilesPanel.shared";
import {
  button,
  DrawerHarness,
  filesHandle,
  previewRegion,
  treeRegion,
  treeScroll,
} from "./FilesPanel.drawer.fixtures";

async function advance(milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function moveOverPreviewEdge() {
  const bounds = previewRegion().getBoundingClientRect();
  document.body.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      pointerType: "mouse",
      clientX: bounds.right - 2,
      clientY: bounds.top + 100,
    }),
  );
}

function pressEscape() {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

describe("Files drawer tab visibility", () => {
  beforeEach(async () => {
    localStorage.removeItem(FILES_TREE_WIDTH_STORAGE_KEY);
    await page.viewport(1000, 700);
    await page.elementLocator(document.body).hover({ position: { x: 950, y: 650 }, force: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.removeItem(FILES_TREE_WIDTH_STORAGE_KEY);
  });

  it.each(["pending", "hover", "open"] as const)(
    "cancels %s drawer state on tab hide and ignores background pointer/Escape despite retained bounds",
    async (mode) => {
      const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
      try {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const preview = previewRegion();
        const tree = treeRegion();
        const scroll = treeScroll();
        const bounds = preview.getBoundingClientRect();
        if (mode === "open") filesHandle().click();
        else moveOverPreviewEdge();
        await advance(mode === "hover" ? 250 : mode === "pending" ? 200 : 0);
        expect(tree.inert).toBe(mode === "pending");

        await mounted.rerender(<DrawerHarness initialPreview="docs/readme.md" visible={false} />);
        expect(previewRegion()).toBe(preview);
        expect(treeScroll()).toBe(scroll);
        expect(getComputedStyle(preview).visibility).toBe("hidden");
        expect(preview.getBoundingClientRect().width).toBe(bounds.width);
        expect(preview.getBoundingClientRect().height).toBe(bounds.height);
        expect(tree.inert).toBe(true);
        moveOverPreviewEdge(); // another tab occupies these same screen coordinates
        await advance(2000);
        expect(tree.inert).toBe(true);
        expect(pressEscape().defaultPrevented).toBe(false);

        await mounted.rerender(<DrawerHarness initialPreview="docs/readme.md" visible />);
        await advance(2000);
        expect(tree.inert).toBe(true); // no stale reveal when returning to Files
        moveOverPreviewEdge();
        await advance(250);
        expect(tree.inert).toBe(false);
        expect(pressEscape().defaultPrevented).toBe(true); // visible ownership resumes
        await advance(0);
        expect(tree.inert).toBe(true);
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("does not arm listeners when mounted initially hidden", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" visible={false} />);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      expect(previewRegion().getBoundingClientRect().width).toBeGreaterThan(0);
      moveOverPreviewEdge();
      filesHandle().click(); // even programmatic activation cannot schedule hidden focus/open
      await advance(2000);
      expect(treeRegion().inert).toBe(true);
      expect(pressEscape().defaultPrevented).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it("retains the pinned split, mounted scroll, expansion and preview when another tab is active", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      button("Keep tree beside file").click();
      await advance(0);
      button("docs").click();
      await advance(0);
      const scroll = treeScroll();
      scroll.scrollTop = 300;
      const savedScroll = scroll.scrollTop;
      const tree = treeRegion();
      const preview = previewRegion();
      const width = tree.getBoundingClientRect().width;
      await mounted.rerender(<DrawerHarness initialPreview="docs/readme.md" visible={false} />);
      moveOverPreviewEdge();
      await advance(2000);
      expect(pressEscape().defaultPrevented).toBe(false);
      await mounted.rerender(<DrawerHarness initialPreview="docs/readme.md" visible />);
      await advance(0);
      expect(treeRegion()).toBe(tree);
      expect(treeScroll()).toBe(scroll);
      expect(scroll.scrollTop).toBe(savedScroll);
      expect(
        [...tree.querySelectorAll("button")].some((row) => row.textContent === "readme.md"),
      ).toBe(false);
      expect(previewRegion()).toBe(preview);
      expect(tree.getBoundingClientRect().width).toBe(width);
      expect(document.querySelector('[role="separator"]')).not.toBeNull();
      expect(button("Unpin file tree").getAttribute("aria-pressed")).toBe("true");
    } finally {
      await mounted.unmount();
    }
  });

  it.each(["open", "dismiss"] as const)(
    "guards queued %s focus against tab hiding",
    async (action) => {
      const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
      const otherTabControl = document.createElement("button");
      otherTabControl.textContent = "Other tab control";
      document.body.append(otherTabControl);
      try {
        if (action === "dismiss") {
          filesHandle().click();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          button("readme.md").focus();
        }
        const queued: FrameRequestCallback[] = [];
        const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
          queued.push(callback);
          return queued.length;
        });
        if (action === "open") filesHandle().click();
        else pressEscape();
        await mounted.rerender(<DrawerHarness initialPreview="docs/readme.md" visible={false} />);
        otherTabControl.focus();
        expect(queued.length).toBeGreaterThan(0);
        frames.mockRestore();
        for (const callback of queued) callback(performance.now());
        expect(document.activeElement).toBe(otherTabControl);
        expect(treeRegion().inert).toBe(true);
        expect(pressEscape().defaultPrevented).toBe(false);
      } finally {
        vi.restoreAllMocks();
        otherTabControl.remove();
        await mounted.unmount();
      }
    },
  );
});
