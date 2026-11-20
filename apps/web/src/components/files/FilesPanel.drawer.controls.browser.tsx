import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  button,
  DrawerHarness,
  escape,
  filesHandle,
  keyboardOpen,
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

  it("aligns the first tree row in full, hover and kept-open modes with one header control and no pin", async () => {
    const mounted = await render(<DrawerHarness />);
    try {
      const scroll = treeScroll();
      const firstRowY = button("docs").getBoundingClientRect().top;
      const header = document.querySelector<HTMLElement>("[data-files-panel-header]")!;
      expect(firstRowY).toBe(header.getBoundingClientRect().bottom);
      button("readme.md").click();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(true));
      const controls = header.querySelector<HTMLElement>("[data-files-panel-controls]")!;
      expect(controls.querySelectorAll("button")).toHaveLength(1);
      expect(controls.querySelector("button")).toBe(filesHandle());
      expect(document.querySelector(".lucide-pin")).toBeNull();
      expect(document.querySelector('[aria-label="Unpin file tree"]')).toBeNull();
      keyboardOpen();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(false));
      expect(button("docs").getBoundingClientRect().top).toBe(firstRowY);
      expect(treeScroll()).toBe(scroll);
      expect(document.querySelector("[data-files-tree-controls]")).toBeNull();
      expect(document.querySelectorAll('[aria-label="Close file"]')).toHaveLength(1);
      filesHandle().click();
      await vi.waitFor(() => expect(filesHandle().getAttribute("aria-pressed")).toBe("true"));
      expect(button("docs").getBoundingClientRect().top).toBe(firstRowY);
      expect(document.querySelectorAll("[data-files-panel-header]")).toHaveLength(1);
      filesHandle().click();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(true));
      expect(treeScroll()).toBe(scroll);
    } finally {
      await mounted.unmount();
    }
  });

  it("toggles keep-open from the Files icon, ignores Escape while kept open, and returns focus", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      const folder = filesHandle();
      expect(folder.getAttribute("aria-label")).toBe("Keep file tree open");
      expect(folder.getAttribute("aria-pressed")).toBe("false");
      folder.click();
      await vi.waitFor(() => expect(folder.getAttribute("aria-label")).toBe("Close file tree"));
      expect(folder.getAttribute("aria-pressed")).toBe("true");
      expect(folder.classList).toContain("bg-accent");
      expect(document.querySelector('[role="separator"]')).not.toBeNull();
      escape(folder);
      expect(treeRegion().inert).toBe(false); // Escape never closes a kept-open tree
      button("file-3.ts").click(); // opening another file keeps it open
      await vi.waitFor(() =>
        expect(document.querySelector("[data-preview-content]")?.textContent).toContain(
          "file-3.ts",
        ),
      );
      expect(treeRegion().inert).toBe(false);
      expect(folder.getAttribute("aria-pressed")).toBe("true");
      folder.click();
      await vi.waitFor(() => expect(treeRegion().inert).toBe(true));
      await vi.waitFor(() => expect(document.activeElement).toBe(folder));
      expect(folder.getAttribute("aria-pressed")).toBe("false");
      expect(folder.classList).not.toContain("bg-accent");
      expect(document.querySelector('[role="separator"]')).toBeNull();
      expect(previewRegion().getBoundingClientRect().width).toBe(900);
      keyboardOpen(); // back to normal: a transient tree that Escape closes
      await vi.waitFor(() => expect(treeRegion().inert).toBe(false));
      expect(folder.getAttribute("aria-pressed")).toBe("false");
      escape(folder);
      await vi.waitFor(() => expect(treeRegion().inert).toBe(true));
      await vi.waitFor(() => expect(document.activeElement).toBe(folder));
    } finally {
      await mounted.unmount();
    }
  });

  it.each([900, 500, 320])(
    "centers the file path between history and a right-aligned file-close X at width %s",
    async (width) => {
      const file =
        "directory-with-a-long-name/a-very-long-file-name-that-must-not-hide-its-close-button.ts";
      const mounted = await render(<DrawerHarness initialPreview={file} width={width} />);
      try {
        const header = document.querySelector<HTMLElement>("[data-file-preview-header]")!;
        const identity = header.querySelector<HTMLElement>("[data-file-preview-identity]")!;
        const close = button("Close file");
        expect(close.closest("[data-file-preview-identity]")).toBeNull();
        expect(document.querySelectorAll('[aria-label="Close file"]')).toHaveLength(1);
        const headerBounds = header.getBoundingClientRect();
        const bounds = close.getBoundingClientRect();
        const identityBounds = identity.getBoundingClientRect();
        expect(headerBounds.right - bounds.right).toBeLessThanOrEqual(12);
        expect(identityBounds.left).toBeGreaterThanOrEqual(
          button("Forward").getBoundingClientRect().right,
        );
        expect(identityBounds.right).toBeLessThanOrEqual(bounds.left);
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

  it("centers a short file path within the preview header", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      const header = document.querySelector<HTMLElement>("[data-file-preview-header]")!;
      const identity = header.querySelector<HTMLElement>("[data-file-preview-identity]")!;
      const headerBounds = header.getBoundingClientRect();
      const identityBounds = identity.getBoundingClientRect();
      const headerCenter = headerBounds.left + headerBounds.width / 2;
      const identityCenter = identityBounds.left + identityBounds.width / 2;
      expect(Math.abs(headerCenter - identityCenter)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.unmount();
    }
  });

  it("suppresses real edge hover after Escape or folder toggle until leaving and reentering, while clicks keep it open", async () => {
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
      filesHandle().click(); // a click keeps the hover-open tree open
      await advance(0);
      expect(filesHandle().getAttribute("aria-pressed")).toBe("true");
      filesHandle().click(); // a second click returns to normal and closes it
      await advance(0);
      expect(treeRegion().inert).toBe(true);
      await hoverPreview(bounds.width - 3, 100);
      await advance(2000);
      expect(treeRegion().inert).toBe(true);
      filesHandle().click(); // keeping open bypasses hover suppression
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
