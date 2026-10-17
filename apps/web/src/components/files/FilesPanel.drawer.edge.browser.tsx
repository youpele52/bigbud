import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { EMPTY_FILE_HISTORY } from "../../stores/files/filesPanel.history";
import { renderFilesPanelPreviewBody } from "./FilesPanel.previewBody";
import { FILES_DRAWER_EDGE_WIDTH } from "./FilesPanel.drawer.edge";
import { button, DrawerHarness, previewRegion, treeRegion } from "./FilesPanel.drawer.fixtures";

async function advance(milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function hoverPreview(x: number, y: number) {
  await page.elementLocator(previewRegion()).hover({ position: { x, y }, force: true });
}

describe("full-height files drawer preview edge", () => {
  beforeEach(async () => {
    await page.viewport(1000, 700);
    // Real browser pointer position persists between tests. Start outside the fixture.
    await page.elementLocator(document.body).hover({ position: { x: 950, y: 650 }, force: true });
  });
  afterEach(() => vi.useRealTimers());

  it.each(["top", "middle", "bottom"] as const)(
    "reveals from the real %s edge, including toolbar/scrollbar, without reflow",
    async (position) => {
      const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
      try {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const preview = previewRegion();
        const content = document.querySelector<HTMLDivElement>("[data-preview-content]")!;
        const bounds = preview.getBoundingClientRect();
        const y =
          position === "top" ? 1 : position === "bottom" ? bounds.height - 2 : bounds.height / 2;
        expect(
          document
            .elementFromPoint(bounds.right - 2, bounds.top + y)
            ?.closest("[data-files-preview]"),
        ).toBe(preview);
        await hoverPreview(bounds.width - 2, y);
        await advance(249);
        expect(treeRegion().inert).toBe(true);
        await advance(1);
        expect(treeRegion().inert).toBe(false);
        expect(preview.getBoundingClientRect().width).toBe(bounds.width);
        expect(document.querySelector("[data-preview-content]")).toBe(content);
        expect(treeRegion().getBoundingClientRect().top).toBe(bounds.top);

        // Handoff to the revealed tree cancels dismissal; leaving it starts the grace period.
        await page.elementLocator(treeRegion()).hover({ position: { x: 30, y: 80 }, force: true });
        await advance(1100);
        expect(treeRegion().inert).toBe(false);
        await hoverPreview(50, bounds.height / 2);
        await advance(999);
        expect(treeRegion().inert).toBe(false);
        await advance(1);
        expect(treeRegion().inert).toBe(true);
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("cancels reveal on exiting the strip while still within the preview and never triggers away from the edge", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const bounds = previewRegion().getBoundingClientRect();
      await hoverPreview(bounds.width - FILES_DRAWER_EDGE_WIDTH - 2, 20);
      await advance(1000);
      expect(treeRegion().inert).toBe(true);
      await hoverPreview(bounds.width - 2, 20);
      await advance(200);
      await hoverPreview(bounds.width / 2, 20);
      await advance(1000);
      expect(treeRegion().inert).toBe(true);
      await hoverPreview(bounds.width - 2, bounds.height / 2);
      await advance(250);
      expect(treeRegion().inert).toBe(false);
      button("Keep tree beside file").click();
      await advance(0);
      await hoverPreview(previewRegion().getBoundingClientRect().width - 2, 20);
      await advance(2000);
      expect(button("Unpin file tree")).toBeTruthy();
      expect(document.querySelector('[role="separator"]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("does not put a hit-test layer over native scrollbar clicks/drags or cancel wheel input", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const scroll = document.querySelector<HTMLDivElement>("[data-preview-content]")!;
      const bounds = scroll.getBoundingClientRect();
      const nativeBarWidth = scroll.offsetWidth - scroll.clientWidth;
      expect(nativeBarWidth).toBeGreaterThan(0);
      expect(document.elementFromPoint(bounds.right - 2, bounds.top + bounds.height / 2)).toBe(
        scroll,
      );
      await page
        .elementLocator(scroll)
        .click({ position: { x: bounds.width - 2, y: bounds.height * 0.8 }, force: true });
      // Native scrolling commits asynchronously. Retry without advancing drawer hover timers.
      await vi.waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(0), { interval: 0 });
      scroll.scrollTop = 0;
      const thumbHeight = (scroll.clientHeight * scroll.clientHeight) / scroll.scrollHeight;
      // Playwright's provider uses physical mouse down/move/up for this operation,
      // so the native scrollbar thumb (rather than an HTML draggable row) owns the drag.
      await userEvent.dragAndDrop(scroll, scroll, {
        force: true,
        sourcePosition: { x: bounds.width - 2, y: thumbHeight / 2 },
        targetPosition: { x: bounds.width - 2, y: bounds.height * 0.65 },
      });
      await vi.waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(0), { interval: 0 });
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
      expect(scroll.dispatchEvent(wheel)).toBe(true);
      expect(wheel.defaultPrevented).toBe(false);
      expect(treeRegion().inert).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps native scrollbar null-target handoff eligible but cancels reveal on a genuine viewport exit", async () => {
    const mounted = await render(<DrawerHarness initialPreview="docs/readme.md" />);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const preview = previewRegion();
      const bounds = preview.getBoundingClientRect();
      await hoverPreview(bounds.width - 2, 20);
      preview.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          relatedTarget: null,
          pointerType: "mouse",
          clientX: bounds.right - 2,
          clientY: bounds.top + 20,
        }),
      );
      await advance(250);
      expect(treeRegion().inert).toBe(false);
      preview.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          relatedTarget: null,
          pointerType: "mouse",
          clientX: window.innerWidth,
          clientY: bounds.top + 20,
        }),
      );
      await advance(1000);
      expect(treeRegion().inert).toBe(true);
      await hoverPreview(50, 20);
      await hoverPreview(bounds.width - 2, 20);
      await advance(200);
      preview.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          relatedTarget: null,
          pointerType: "mouse",
          clientX: window.innerWidth,
          clientY: bounds.top + 20,
        }),
      );
      await advance(1000);
      expect(treeRegion().inert).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the top Files header in no-preview and no-workspace states", async () => {
    const mounted = await render(<DrawerHarness />);
    try {
      expect(document.querySelector("[data-files-panel-header]")?.textContent).toBe("Files");
      expect(document.querySelector("[data-files-tree-toggle]")).toBeNull();
      const emptyBody = renderFilesPanelPreviewBody({
        workspaceRoot: null,
        previewPath: null,
        treeBody: null,
        workspaceKey: "none",
        contextMenuOpen: false,
        history: EMPTY_FILE_HISTORY,
        historyEntry: undefined,
        targetLine: undefined,
        executionTargetId: undefined,
        projectName: undefined,
        onNavigateBack: () => {},
        onNavigateForward: () => {},
        onClose: () => {},
        onPreviewLoadError: () => {},
        onScrollPositionChange: () => {},
        onCreateAnnotation: undefined,
        onSearchMatch: () => {},
      });
      await mounted.rerender(<div style={{ width: 900, height: 500 }}>{emptyBody}</div>);
      expect(document.querySelectorAll("[data-files-panel-header]")).toHaveLength(1);
      expect(document.querySelector("[data-files-panel-header]")?.textContent).toBe("Files");
      expect(treeRegion().textContent).toContain("Select a project to browse files.");
    } finally {
      await mounted.unmount();
    }
  });
});
