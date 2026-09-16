import { useState } from "react";

/** Render a bounded prefix while retaining the full collection for search and navigation. */
export function useIncrementalList<T>({
  items,
  resetKey,
  initialCount = 5,
  increment = 5,
  enabled = true,
  revealIndex = -1,
  bottomThreshold = 96,
}: {
  items: ReadonlyArray<T>;
  resetKey: string;
  initialCount?: number;
  increment?: number;
  enabled?: boolean;
  revealIndex?: number;
  bottomThreshold?: number;
}) {
  const [page, setPage] = useState({ resetKey, total: items.length, count: initialCount });
  const reset = page.resetKey !== resetKey || page.total !== items.length;
  const requestedCount = reset ? initialCount : page.count;
  const revealCount =
    revealIndex < initialCount
      ? initialCount
      : initialCount + Math.ceil((revealIndex + 1 - initialCount) / increment) * increment;
  const count = Math.min(items.length, Math.max(requestedCount, revealCount));

  // Reset during render so a new search never paints the previous search's expanded page.
  if (reset || count > page.count) {
    setPage({ resetKey, total: items.length, count });
  }

  const hasMore = enabled && count < items.length;
  const loadMore = () => {
    if (hasMore) setPage({ resetKey, total: items.length, count: count + increment });
  };
  const onScroll = (element: HTMLElement) => {
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - bottomThreshold) {
      loadMore();
    }
  };
  const onWheel = (element: HTMLElement, deltaY: number) => {
    // A short first page has no scrollbar yet, but a downward gesture should reveal more.
    if (deltaY > 0 && element.scrollHeight <= element.clientHeight) loadMore();
  };

  return {
    items: enabled ? items.slice(0, count) : items,
    hasMore,
    loadMore,
    onScroll,
    onWheel,
  };
}
