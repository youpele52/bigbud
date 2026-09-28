import { useLayoutEffect, useRef, useState } from "react";

export function useTimelineWidth() {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;
    const updateWidth = (nextWidth: number) => {
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
