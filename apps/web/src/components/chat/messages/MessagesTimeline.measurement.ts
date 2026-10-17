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

export function useTimelineWidth() {
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
  }, []);

  return { timelineRootRef, timelineWidthPx };
}
