import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  INTEGRATION_CONTENTS,
  activateSearchContext,
  assertScrollable,
  deferredPreview,
  mountPreview,
  moveReader,
  nextPaint,
  previewMocks,
  previewView,
  previewViewport,
  rawViewport,
  resetPreviewMocks,
  switchMode,
} from "./FilePreview.scroll.integration.fixtures";

describe("FilePreview loading and identity integration", () => {
  beforeEach(resetPreviewMocks);

  it("honors a mode selected while the first file read is pending", async () => {
    const read = deferredPreview();
    previewMocks.read.mockReturnValueOnce(read.promise);
    const mounted = await render(previewView());
    try {
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        "Loading file preview",
      );
      document.querySelector<HTMLButtonElement>('[aria-label="View raw markdown"]')!.click();
      read.resolve({ contents: INTEGRATION_CONTENTS, truncated: false });
      await vi.waitFor(() => expect(document.querySelector(".file-preview-code")).not.toBeNull());
      assertScrollable(rawViewport());
      expect(rawViewport().scrollTop).toBe(0);
      expect(previewMocks.read).toHaveBeenCalledOnce();
      expect(previewMocks.loadError).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps a mode chosen in an error state through a successful watched retry", async () => {
    previewMocks.read.mockRejectedValueOnce(new Error("Read temporarily unavailable"));
    const mounted = await render(previewView());
    try {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("Read temporarily unavailable"),
      );
      document.querySelector<HTMLButtonElement>('[aria-label="View raw markdown"]')!.click();
      previewMocks.watches.at(-1)!.callback();
      await vi.waitFor(() => expect(document.querySelector(".file-preview-code")).not.toBeNull());
      assertScrollable(rawViewport());
      expect(rawViewport().scrollTop).toBe(0);
      expect(previewMocks.loadError).toHaveBeenCalledOnce();
      expect(previewMocks.read).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.unmount();
    }
  });

  it.each([
    { relativePath: "docs/OTHER.MD" },
    { relativePath: "docs/OTHER.mdx" },
    { cwd: "/other-workspace" },
    { executionTargetId: "remote-integration-agent" },
  ])("resets to Preview and rejects stale work after identity changes: %j", async (identity) => {
    const onScrollPositionChange = vi.fn();
    const mounted = await mountPreview({ initialScrollTop: 315, onScrollPositionChange });
    const staleRead = deferredPreview();
    const currentRead = deferredPreview();
    try {
      moveReader(previewViewport(), 1100);
      const previousSearch = activateSearchContext();
      const previousRaw = await switchMode("raw");
      const previousWatch = previewMocks.watches.at(-1)!;
      previewMocks.read
        .mockReturnValueOnce(staleRead.promise)
        .mockReturnValueOnce(currentRead.promise);
      previousWatch.callback();
      await vi.waitFor(() => expect(previewMocks.read).toHaveBeenCalledTimes(2));

      await mounted.rerender(
        previewView({ ...identity, initialScrollTop: 315, onScrollPositionChange }),
      );
      await vi.waitFor(() => expect(previewMocks.read).toHaveBeenCalledTimes(3));
      expect(previousWatch.unsubscribe).toHaveBeenCalledOnce();
      currentRead.resolve({
        contents: INTEGRATION_CONTENTS.replace("Section 1", "Current section 1"),
        truncated: false,
      });
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-markdown")?.textContent).toContain(
          "Current section 1",
        ),
      );
      const currentViewport = previewViewport();
      assertScrollable(currentViewport);
      await vi.waitFor(() => expect(currentViewport.scrollTop).toBe(315));
      moveReader(currentViewport, 473);
      onScrollPositionChange.mockClear();

      staleRead.resolve({ contents: "# Stale response", truncated: false });
      previousRaw.dispatchEvent(new Event("scroll", { bubbles: true }));
      previousSearch.onSelectMatch(12);
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      expect(document.querySelector(".file-preview-markdown")?.textContent).toContain(
        "Current section 1",
      );
      expect(currentViewport.scrollTop).toBe(473);
      expect(onScrollPositionChange.mock.calls.every(([top]) => top === 473)).toBe(true);
    } finally {
      staleRead.resolve({ contents: INTEGRATION_CONTENTS, truncated: false });
      currentRead.resolve({ contents: INTEGRATION_CONTENTS, truncated: false });
      await mounted.unmount();
    }
  });

  it("opens Preview when returning to a file whose previous visit ended in Raw", async () => {
    const mounted = await mountPreview();
    try {
      const firstRaw = await switchMode("raw");
      moveReader(firstRaw, 670);

      await mounted.rerender(previewView({ relativePath: "docs/OTHER.md" }));
      await vi.waitFor(() => {
        expect(previewMocks.read).toHaveBeenCalledTimes(2);
        expect(document.querySelector(".file-preview-markdown")).not.toBeNull();
      });
      assertScrollable(previewViewport());
      moveReader(previewViewport(), 487);

      await mounted.rerender(previewView());
      await vi.waitFor(() => {
        expect(previewMocks.read).toHaveBeenCalledTimes(3);
        expect(document.querySelector(".file-preview-markdown")).not.toBeNull();
      });
      assertScrollable(previewViewport());
      expect(document.querySelector(".file-preview-code")).toBeNull();
      expect(previewViewport().scrollTop).toBe(0);
      expect(previewMocks.read).toHaveBeenLastCalledWith({
        cwd: "/workspace",
        relativePath: "docs/CHANGELOG.md",
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps an unchanged passage within two pixels across rapid mode switches", async () => {
    const mounted = await mountPreview();
    try {
      const raw = await switchMode("raw");
      await vi.waitFor(() => expect(raw.querySelector(".chat-markdown-shiki")).not.toBeNull());
      moveReader(raw, 670);
      for (let cycle = 0; cycle < 6; cycle += 1) {
        await switchMode("preview");
        const returned = await switchMode("raw");
        expect(Math.abs(returned.scrollTop - 670)).toBeLessThanOrEqual(2);
      }
      expect(previewMocks.read).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("preserves the active viewport for unchanged refreshes and cancels stale restoration on changed content", async () => {
    const mounted = await mountPreview();
    try {
      moveReader(previewViewport(), 915);
      const raw = await switchMode("raw");
      moveReader(raw, 670);
      const preview = await switchMode("preview");
      const beforeRefresh = preview.scrollTop;

      previewMocks.watches.at(-1)!.callback();
      await vi.waitFor(() => expect(previewMocks.read).toHaveBeenCalledTimes(2));
      await nextPaint();
      expect(previewViewport()).toBe(preview);
      expect(Math.abs(preview.scrollTop - beforeRefresh)).toBeLessThanOrEqual(2);

      const previousSearch = activateSearchContext();
      const changed = INTEGRATION_CONTENTS.replace("Section 1", "Updated section 1");
      previewMocks.read.mockResolvedValueOnce({ contents: changed, truncated: false });
      previewMocks.watches.at(-1)!.callback();
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-markdown")?.textContent).toContain(
          "Updated section 1",
        ),
      );
      moveReader(previewViewport(), 437);
      previousSearch.onSelectMatch(12);
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      expect(previewViewport().scrollTop).toBe(437);
      const refreshedRaw = await switchMode("raw");
      expect(refreshedRaw.textContent).toContain("Updated section 1");
      expect(refreshedRaw.scrollTop).toBeGreaterThan(0);
      expect(previewMocks.read).toHaveBeenCalledTimes(3);
    } finally {
      await mounted.unmount();
    }
  });

  it("disconnects watches and pending callbacks when the entire viewer unmounts", async () => {
    const onScrollPositionChange = vi.fn();
    const mounted = await mountPreview({ onScrollPositionChange });
    moveReader(previewViewport(), 750);
    const raw = await switchMode("raw");
    const watch = previewMocks.watches.at(-1)!;
    watch.callback();
    await mounted.unmount();
    const readCountAtUnmount = previewMocks.read.mock.calls.length;
    const reportCountAtUnmount = onScrollPositionChange.mock.calls.length;
    raw.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    expect(watch.unsubscribe).toHaveBeenCalledOnce();
    expect(previewMocks.read).toHaveBeenCalledTimes(readCountAtUnmount);
    expect(onScrollPositionChange).toHaveBeenCalledTimes(reportCountAtUnmount);
    expect(document.querySelector("[data-file-preview-search-focus]")).toBeNull();
  });

  it("keeps loaded content and its position if a background refresh fails", async () => {
    const mounted = await mountPreview();
    try {
      moveReader(previewViewport(), 967);
      previewMocks.read.mockRejectedValueOnce(new Error("Background read failed"));
      previewMocks.watches.at(-1)!.callback();
      await vi.waitFor(() => expect(previewMocks.loadError).toHaveBeenCalledOnce());
      await nextPaint();
      expect(previewViewport().scrollTop).toBe(967);
      expect(document.querySelector(".file-preview-markdown")?.textContent).toContain("Section 42");
      expect(document.body.textContent).not.toContain("Background read failed");
      await switchMode("raw");
      await switchMode("preview");
      expect(Math.abs(previewViewport().scrollTop - 967)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("ignores an in-flight read failure after unmount without reporting an error or a stale position", async () => {
    const onScrollPositionChange = vi.fn();
    const onSearchMatch = vi.fn();
    const mounted = await mountPreview({ onScrollPositionChange, onSearchMatch });
    const refresh = deferredPreview();
    moveReader(previewViewport(), 787);
    const previousSearch = activateSearchContext();
    await switchMode("raw");
    previewMocks.read.mockReturnValueOnce(refresh.promise);
    previewMocks.watches.at(-1)!.callback();
    await vi.waitFor(() => expect(previewMocks.read).toHaveBeenCalledTimes(2));
    await mounted.unmount();
    const finalReports = onScrollPositionChange.mock.calls.length;
    refresh.reject(new Error("Obsolete request failed"));
    previousSearch.onSelectMatch(12);
    await nextPaint();
    expect(previewMocks.loadError).not.toHaveBeenCalled();
    expect(onSearchMatch).not.toHaveBeenCalled();
    expect(onScrollPositionChange).toHaveBeenCalledTimes(finalReports);
  });
});
