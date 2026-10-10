import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  button,
  DrawerHarness,
  escape,
  filesHandle,
  previewRegion,
  treeRegion,
  treeScroll,
} from "./FilesPanel.drawer.fixtures";

async function advance(milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function hoverPreview(x: number, y: number) {
  await page.elementLocator(previewRegion()).hover({ position: { x, y }, force: true });
}

describe("single Files header controls", () => {
  beforeEach(async () => {
    await page.viewport(1000, 700);
    await page.elementLocator(document.body).hover({ position: { x: 950, y: 650 }, force: true });
  });
  afterEach(() => vi.useRealTimers());

  it("aligns the first tree row in full, overlay and pinned modes without a secondary toolbar or tree X", async () => {
    const mounted = await render(<DrawerHarness />);
    try {
      const scroll = treeScroll();
      const firstRowY = button("docs").getBoundingClientRect().top;
      const header = document.querySelector<HTMLElement>("[data-files-panel-header]")!;
      expect(firstRowY).toBe(header.getBoundingClientRect().bottom);
      button("readme.md").click();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(true));
      filesHandle().click();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(false));
      expect(button("docs").getBoundingClientRect().top).toBe(firstRowY);
      expect(treeScroll()).toBe(scroll);
      expect(document.querySelector("[data-files-tree-controls]")).toBeNull();
      expect(document.querySelector('[aria-label="Close files tree"]')).toBeNull();
      expect(document.querySelectorAll('[aria-label="Close file"]')).toHaveLength(1);
      const pin = button("Keep tree beside file");
      expect(pin.closest("[data-files-panel-header]")).toBe(header);
      expect(pin.getBoundingClientRect().right).toBeLessThan(
        filesHandle().getBoundingClientRect().left,
      );
      pin.click();
      await vi.waitFor(() => expect(document.querySelector('[role="separator"]')).not.toBeNull());
      expect(button("docs").getBoundingClientRect().top).toBe(firstRowY);
      expect(document.querySelectorAll("[data-files-panel-header]")).toHaveLength(1);
      button("Unpin file tree").click();
      await vi.waitFor(() => expect(document.querySelector('[role="separator"]')).toBeNull());
      expect(button("docs").getBoundingClientRect().top).toBe(firstRowY);
    } finally {
      await mounted.unmount();
    }
  });

  it("toggles pinned trees closed, clears the pin, and retains controls and focus return", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      const folder = filesHandle();
      expect(folder.getAttribute("aria-label")).toBe("Show file tree");
      button("Keep tree beside file").click();
      await vi.waitFor(() => expect(folder.getAttribute("aria-label")).toBe("Hide file tree"));
      expect(folder.getAttribute("aria-pressed")).toBe("true");
      expect(folder.classList).toContain("bg-accent");
      expect(button("Unpin file tree").getAttribute("aria-pressed")).toBe("true");
      folder.click();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(true));
      await vi.waitFor(() => expect(document.activeElement).toBe(folder));
      expect(document.querySelector('[role="separator"]')).toBeNull();
      expect(button("Keep tree beside file").getAttribute("aria-pressed")).toBe("false");
      folder.click();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(false));
      expect(document.querySelector('[role="separator"]')).toBeNull();
      expect(previewRegion().getBoundingClientRect().width).toBe(900);
      button("Keep tree beside file").focus();
      button("Keep tree beside file").click();
      await vi.waitFor(() => expect(document.querySelector('[role="separator"]')).not.toBeNull());
      escape(button("Unpin file tree"));
      expect(treeRegion().inert).toBe(false); // Escape remains an overlay dismissal, not unpin.
      expect(document.querySelector('[role="separator"]')).not.toBeNull();
      button("Unpin file tree").click();
      await vi.waitFor(() => expect(document.querySelector('[role="separator"]')).toBeNull());
      button("Keep tree beside file").focus();
      escape(button("Keep tree beside file"));
      await vi.waitFor(() => expect(treeRegion().inert).toBe(true));
      await vi.waitFor(() => expect(document.activeElement).toBe(folder));
      expect(document.querySelector('[role="separator"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it.each([900, 500, 320])(
    "keeps the shared file-close X beside a long filename and hittable above an overlay at width %s",
    async (width) => {
      const file =
        "directory-with-a-long-name/a-very-long-file-name-that-must-not-hide-its-close-button.ts";
      const mounted = await render(<DrawerHarness initialPreview={file} width={width} />);
      try {
        filesHandle().click();
        await vi.waitFor(() => expect(treeRegion().inert).toBe(false));
        const close = button("Close file");
        expect(close.closest("[data-file-preview-identity]")).not.toBeNull();
        expect(document.querySelectorAll('[aria-label="Close file"]')).toHaveLength(1);
        const bounds = close.getBoundingClientRect();
        expect(bounds.right).toBeLessThanOrEqual(treeRegion().getBoundingClientRect().left);
        expect(
          document
            .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            ?.closest("button"),
        ).toBe(close);
        await page.getByRole("button", { name: "Close file", exact: true }).click();
        await vi.waitFor(() =>
          expect(document.querySelector("[data-file-preview-header]")).toBeNull(),
        );
        expect(treeRegion().inert).toBe(false);
        expect(treeRegion().getBoundingClientRect().width).toBe(width);
        expect(button("readme.md")).toBeTruthy(); // closing preview never deletes tree entries
        expect(document.querySelector("[data-files-panel-controls]")).toBeNull();
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("suppresses real edge hover after Escape or folder toggle until leaving and reentering, while clicks still open persistently", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const bounds = previewRegion().getBoundingClientRect();
      await hoverPreview(bounds.width - 2, 100);
      await advance(250);
      expect(treeRegion().inert).toBe(false);
      const escapeEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(escapeEvent);
      expect(escapeEvent.defaultPrevented).toBe(true);
      await advance(0);
      expect(treeRegion().inert).toBe(true);
      await hoverPreview(bounds.width - 3, 100);
      await advance(2000);
      expect(treeRegion().inert).toBe(true);
      await hoverPreview(50, 100);
      await hoverPreview(bounds.width - 2, 100);
      await advance(249);
      expect(treeRegion().inert).toBe(true);
      await advance(1);
      expect(treeRegion().inert).toBe(false);
      filesHandle().click(); // a click closes the hover-open tree, not promotes it
      await advance(0);
      await hoverPreview(bounds.width - 3, 100);
      await advance(2000);
      expect(treeRegion().inert).toBe(true);
      filesHandle().click(); // explicit opening bypasses hover suppression
      await advance(0);
      previewRegion().focus();
      await hoverPreview(50, 100);
      await advance(2000);
      expect(treeRegion().inert).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });
});
