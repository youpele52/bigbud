import { useLayoutEffect, useRef, useState } from "react";
import { measureElement, type Virtualizer } from "@tanstack/react-virtual";

/** Hidden rows have no layout box; retain their measured size until visible again. */
export function measureVisibleTimelineElement<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
>(
  element: TItemElement,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<TScrollElement, TItemElement>,
): number {
  if (element.getClientRects().length === 0) {
    const index = instance.indexFromElement(element);
    return instance.measurementsCache[index]?.size ?? instance.options.estimateSize(index);
  }
  return measureElement(element, entry, instance);
}

/** Invalidate offscreen estimates, then restore only mounted rows before paint. */
export function resetTimelineMeasurements<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
>(instance: Virtualizer<TScrollElement, TItemElement>): void {
  // TanStack's measure() clears sizes; it does not read any DOM elements.
  instance.measure();
  // Rebuild the estimate baseline before resizeItem compares actual sizes with it.
  instance.getTotalSize();
  for (const element of new Set(instance.elementsCache.values())) {
    if (!element.isConnected || element.getClientRects().length === 0) continue;
    const index = instance.indexFromElement(element);
    // Unlike measureElement(), resizeItem() also updates during user scrolling.
    instance.resizeItem(index, instance.options.measureElement(element, undefined, instance));
  }
}

export function useTimelineWidth(hasTimelineRoot: boolean) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;
    const updateWidth = (nextWidth: number) => {
      // display:none is presentation-only, not a wrapping-width change.
      if (nextWidth <= 0) return;
      setTimelineWidthPx((previousWidth) =>
        previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5
          ? previousWidth
          : nextWidth,
      );
    };
    updateWidth(timelineRoot.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateWidth(timelineRoot.getBoundingClientRect().width);
    });
    observer.observe(timelineRoot);
    return () => observer.disconnect();
  }, [hasTimelineRoot]);

  return { timelineRootRef, timelineWidthPx };
}
