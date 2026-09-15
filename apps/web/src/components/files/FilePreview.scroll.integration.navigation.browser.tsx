import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  headingOffset,
  mountPreview,
  moveReader,
  nextPaint,
  previewMocks,
  previewView,
  previewViewport,
  resetPreviewMocks,
  selectSearchMatch,
  sourceLine,
  switchMode,
} from "./FilePreview.scroll.integration.fixtures";

async function expectHeadingVisible(text: string) {
  await vi.waitFor(() => {
    const offset = headingOffset(text);
    expect(offset).toBeGreaterThanOrEqual(-2);
    expect(offset).toBeLessThan(previewViewport().clientHeight - 20);
  });
}

describe("FilePreview explicit positioning integration", () => {
  beforeEach(resetPreviewMocks);

  it("positions a target in rendered geometry once, and gives a new target priority over handoff and history", async () => {
    const initialTarget = sourceLine("## Section 22");
    const mounted = await mountPreview({ targetLine: initialTarget, initialScrollTop: 50 });
    try {
      await expectHeadingVisible("Section 22");
      expect(previewViewport().scrollTop).toBeGreaterThan(1000);
      moveReader(previewViewport(), 811);
      await switchMode("raw");
      await switchMode("preview");
      await vi.waitFor(() =>
        expect(Math.abs(previewViewport().scrollTop - 811)).toBeLessThanOrEqual(2),
      );

      previewMocks.watches.at(-1)!.callback();
      await vi.waitFor(() => expect(previewMocks.read).toHaveBeenCalledTimes(2));
      await nextPaint();
      expect(Math.abs(previewViewport().scrollTop - 811)).toBeLessThanOrEqual(2);

      const raw = await switchMode("raw");
      moveReader(raw, 573);
      await switchMode("preview");
      await mounted.rerender(
        previewView({ targetLine: sourceLine("## Section 31"), initialScrollTop: 50 }),
      );
      await expectHeadingVisible("Section 31");
      await nextPaint();
      await expectHeadingVisible("Section 31");
      expect(previewMocks.read).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("lets search supersede a pending handoff and follows that new passage on the next toggle", async () => {
    const onSearchMatch = vi.fn();
    const onScrollPositionChange = vi.fn();
    const mounted = await mountPreview({
      onSearchMatch,
      onScrollPositionChange,
      initialScrollTop: 45,
    });
    try {
      moveReader(previewViewport(), 623);
      await switchMode("raw");
      await switchMode("preview");
      selectSearchMatch(sourceLine("## Section 28"));
      await expectHeadingVisible("Section 28");
      expect(onSearchMatch).toHaveBeenCalledWith(sourceLine("## Section 28"));
      const afterSearch = previewViewport().scrollTop;
      expect(afterSearch).toBeGreaterThan(1000);

      await switchMode("raw");
      await switchMode("preview");
      await vi.waitFor(() =>
        expect(Math.abs(previewViewport().scrollTop - afterSearch)).toBeLessThanOrEqual(2),
      );
      await expectHeadingVisible("Section 28");
      await vi.waitFor(() =>
        expect(onScrollPositionChange).toHaveBeenLastCalledWith(previewViewport().scrollTop),
      );
      expect(previewMocks.read).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps annotations on an unchanged mode and clears them on a genuine mode switch", async () => {
    const mounted = await mountPreview();
    try {
      const raw = await switchMode("raw");
      moveReader(raw, 380);
      document.querySelector<HTMLButtonElement>('[aria-label="Annotate line 22"]')!.click();
      await vi.waitFor(() =>
        expect(document.querySelector("[data-annotation-composer]")).not.toBeNull(),
      );
      document.querySelector<HTMLButtonElement>('[aria-label="View raw markdown"]')!.click();
      await nextPaint();
      expect(document.querySelector("[data-annotation-composer]")).not.toBeNull();

      await switchMode("preview");
      expect(document.querySelector("[data-annotation-composer]")).toBeNull();
      await switchMode("raw");
      expect(document.querySelector("[data-annotation-composer]")).toBeNull();
      expect(previewMocks.annotation).not.toHaveBeenCalled();
      expect(previewMocks.read).toHaveBeenCalledOnce();
      expect(previewMocks.back).not.toHaveBeenCalled();
      expect(previewMocks.forward).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});
