import { Virtualizer } from "@tanstack/react-virtual";
import { describe, expect, it } from "vitest";

import { measureVisibleTimelineElement } from "./MessagesTimeline.measurement";

function createVirtualizer() {
  return new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 1,
    getScrollElement: () => null,
    scrollToFn: () => undefined,
    observeElementRect: () => undefined,
    observeElementOffset: () => undefined,
    estimateSize: () => 96,
  });
}

function createRow(visible: boolean, height: number) {
  return {
    getClientRects: () => (visible ? [{}] : []),
    getAttribute: () => "0",
    offsetHeight: height,
  } as unknown as HTMLDivElement;
}

describe("hidden timeline row measurements", () => {
  it("retains the cached height when a hidden row reports zero", () => {
    const instance = createVirtualizer();
    instance.measurementsCache = [{ index: 0, key: 0, start: 0, end: 240, size: 240, lane: 0 }];
    expect(measureVisibleTimelineElement(createRow(false, 0), undefined, instance)).toBe(240);
  });

  it("uses the estimate for an unmeasured hidden row", () => {
    expect(measureVisibleTimelineElement(createRow(false, 0), undefined, createVirtualizer())).toBe(
      96,
    );
  });

  it("resumes actual measurements when visible, including legitimate zero-height rows", () => {
    const instance = createVirtualizer();
    expect(measureVisibleTimelineElement(createRow(true, 312), undefined, instance)).toBe(312);
    expect(measureVisibleTimelineElement(createRow(true, 0), undefined, instance)).toBe(0);
  });

  it("uses the visible ResizeObserver box size", () => {
    const entry = {
      borderBoxSize: [{ blockSize: 123.4, inlineSize: 640 }],
    } as unknown as ResizeObserverEntry;
    expect(measureVisibleTimelineElement(createRow(true, 300), entry, createVirtualizer())).toBe(
      123,
    );
  });
});
