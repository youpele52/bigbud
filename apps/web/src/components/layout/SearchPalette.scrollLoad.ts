import { useEffect, useRef, useState } from "react";

/** A sentinel that comes into view within this long after a scroll counts as scrolled to. */
const SCROLL_WINDOW_MS = 400;
/** Input that moves a list: wheel, touch and keys (arrow keys move the highlighted row). */
const INTENT_EVENTS = ["wheel", "touchmove", "keydown"] as const;

/**
 * Pagination by scroll for palette sections (both palettes). The returned ref goes on the
 * section's "See more" row, which stays a keyboard-accessible button. `onLoad` runs when the
 * user scrolls the row into view (an `IntersectionObserver`, as in `GitPanelHistory`), never just
 * because it was visible when rendered, so nothing past a first page is fetched until scrolled.
 * Only scrolls that follow user input count, so programmatic scrolling (a highlighted row kept in
 * view, a click scrolling its target) never pages. After one load the row must leave the view
 * before it can load again.
 */
export function useScrollIntoViewLoad(onLoad: () => void, enabled = true) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  useEffect(() => {
    if (!node || !enabled || typeof IntersectionObserver === "undefined") return;
    let visible = false;
    let armed = true;
    let lastScrollAt = Number.NEGATIVE_INFINITY;
    let lastIntentAt = Number.NEGATIVE_INFINITY;
    const recent = (at: number) => performance.now() - at < SCROLL_WINDOW_MS;
    const load = () => {
      armed = false;
      onLoadRef.current();
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (!visible) armed = true;
      else if (armed && recent(lastScrollAt)) load();
    });
    const onScroll = (event: Event) => {
      // Scroll events do not bubble; capture them and keep only the ones that move this row.
      if (!(event.target instanceof Node) || !event.target.contains(node)) return;
      if (!recent(lastIntentAt)) return;
      lastScrollAt = performance.now();
      if (visible && armed) load();
    };
    const onIntent = () => {
      lastIntentAt = performance.now();
    };
    observer.observe(node);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    for (const type of INTENT_EVENTS) {
      document.addEventListener(type, onIntent, { capture: true, passive: true });
    }
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", onScroll, { capture: true });
      for (const type of INTENT_EVENTS) {
        document.removeEventListener(type, onIntent, { capture: true });
      }
    };
  }, [node, enabled]);

  return setNode;
}
