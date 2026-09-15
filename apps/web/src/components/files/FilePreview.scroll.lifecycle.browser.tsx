import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  animationFrames,
  changeMode,
  createScrollRefs,
  readerScroll,
  readingAnchor,
  SCROLL_CONTENTS,
  ScrollHarness,
} from "./FilePreview.scroll.fixtures";
import { MARKDOWN_RESTORE_TIMEOUT_MS } from "./FilePreview.scroll.restore";

const CONTENTS = `# Changelog\n\n![Delayed image](delayed-image.png)\n\n${SCROLL_CONTENTS}`;

describe("FilePreview scroll handoff lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("corrects a late image reflow without polling or losing the passage", async () => {
    const refs = createScrollRefs();
    const positions = vi.fn();
    const mounted = await render(
      <ScrollHarness refs={refs} contents={CONTENTS} onPosition={positions} />,
    );
    try {
      await changeMode("raw");
      await readerScroll(refs, 670);
      await changeMode("preview");
      expect(refs.container.current!.scrollTop).toBeGreaterThan(200);
      const image = refs.markdown.current!.querySelector("img")!;
      Object.defineProperty(image, "complete", { configurable: true, value: false });
      const measured = refs.markdown.current!.querySelector("h2")!;
      const measurement = vi.spyOn(measured, "getBoundingClientRect");
      await new Promise((resolve) => setTimeout(resolve, 800));
      // A real image error/font completion may notify once during mount; idle work must stop.
      expect(measurement.mock.calls.length).toBeLessThanOrEqual(6);
      measurement.mockClear();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(measurement).not.toHaveBeenCalled();
      const before = readingAnchor(refs, CONTENTS);
      const originalTop = refs.container.current!.scrollTop;
      expect(positions).toHaveBeenLastCalledWith(originalTop);
      image.style.height = "220px";
      image.style.display = "block";
      image.dispatchEvent(new Event("load"));
      await animationFrames();
      await vi.waitFor(() =>
        expect(refs.container.current!.scrollTop).toBeGreaterThan(originalTop + 150),
      );
      const after = readingAnchor(refs, CONTENTS);
      expect(after.sourceStartLine).toBe(before.sourceStartLine);
      expect(after.sourceProgress).toBeCloseTo(before.sourceProgress, 1);
    } finally {
      await mounted.unmount();
    }
  });

  it("publishes history and stops corrections at the deadline even for stalled images", async () => {
    const refs = createScrollRefs();
    const positions = vi.fn();
    const mounted = await render(
      <ScrollHarness refs={refs} contents={CONTENTS} onPosition={positions} />,
    );
    try {
      await changeMode("raw");
      await readerScroll(refs, 670);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await changeMode("preview");
      const image = refs.markdown.current!.querySelector("img")!;
      Object.defineProperty(image, "complete", { configurable: true, value: false });
      const top = refs.container.current!.scrollTop;
      const measurement = vi.spyOn(
        refs.markdown.current!.querySelector("h2")!,
        "getBoundingClientRect",
      );
      positions.mockClear();
      await vi.advanceTimersByTimeAsync(MARKDOWN_RESTORE_TIMEOUT_MS + 1000);
      await animationFrames();
      expect(measurement).not.toHaveBeenCalled();
      expect(positions).toHaveBeenLastCalledWith(top);
      image.style.height = "220px";
      image.dispatchEvent(new Event("load"));
      await animationFrames();
      expect(refs.container.current!.scrollTop).toBe(top);
      expect(measurement).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await mounted.unmount();
    }
  });

  it.each(["wheel", "touchstart", "keydown", "pointerdown", "external scroll"])(
    "lets %s take priority over later layout corrections",
    async (kind) => {
      const refs = createScrollRefs();
      const positions = vi.fn();
      const mounted = await render(
        <ScrollHarness refs={refs} contents={CONTENTS} onPosition={positions} />,
      );
      try {
        await changeMode("raw");
        await readerScroll(refs, 670);
        await changeMode("preview");
        const container = refs.container.current!;
        if (kind !== "external scroll") {
          const event =
            kind === "keydown"
              ? new KeyboardEvent(kind, { key: "PageDown", bubbles: true })
              : new Event(kind, { bubbles: true });
          container.dispatchEvent(event);
        }
        container.scrollTop = 400;
        container.dispatchEvent(new Event("scroll"));
        await animationFrames();
        expect(positions).toHaveBeenLastCalledWith(400);
        const image = refs.markdown.current!.querySelector("img")!;
        // Keep the browser's own anchoring out of this explicit scroll ownership assertion.
        container.style.overflowAnchor = "none";
        image.style.height = "220px";
        image.dispatchEvent(new Event("load"));
        await animationFrames();
        expect(container.scrollTop).toBe(400);
        const anchor = readingAnchor(refs, CONTENTS);
        await changeMode("raw");
        expect(Math.abs(readingAnchor(refs, CONTENTS).sourceLine - anchor.sourceLine)).toBeLessThan(
          1,
        );
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("preserves the reading context through viewport resizing and invalidates old pixels", async () => {
    const refs = createScrollRefs();
    const mounted = await render(<ScrollHarness refs={refs} contents={CONTENTS} />);
    try {
      await changeMode("raw");
      await readerScroll(refs, 690);
      await changeMode("preview");
      const before = readingAnchor(refs, CONTENTS);
      const initialTop = refs.container.current!.scrollTop;
      await mounted.rerender(<ScrollHarness refs={refs} contents={CONTENTS} width={250} />);
      await animationFrames();
      expect(refs.container.current!.clientWidth).toBeLessThan(300);
      expect(refs.container.current!.scrollTop).not.toBe(initialTop);
      const after = readingAnchor(refs, CONTENTS);
      expect(after.sourceStartLine).toBe(before.sourceStartLine);
      expect(after.sourceProgress).toBeCloseTo(before.sourceProgress, 1);
      await changeMode("raw");
      expect(Math.abs(refs.container.current!.scrollTop - 690)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("disconnects layout callbacks on unmount", async () => {
    const refs = createScrollRefs();
    const positions = vi.fn();
    const mounted = await render(<ScrollHarness refs={refs} onPosition={positions} />);
    await changeMode("raw");
    await readerScroll(refs, 670);
    await changeMode("preview");
    const detachedRoot = refs.markdown.current!;
    await mounted.unmount();
    positions.mockClear();
    detachedRoot.style.paddingTop = "900px";
    detachedRoot.dispatchEvent(new Event("load"));
    await animationFrames();
    expect(positions).not.toHaveBeenCalled();
  });
});
