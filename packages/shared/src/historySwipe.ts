export interface HistorySwipeSample {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly time: number;
  readonly blocked: boolean;
}

export type HistorySwipeDirection = "back" | "forward";

/**
 * Recognizes one deliberate horizontal gesture and commits as soon as it qualifies.
 * macOS drops the phase-ended event when momentum follows a flick, so the native
 * scroll end can arrive seconds later; waiting for it would reject real swipes.
 */
export function createHistorySwipeRecognizer() {
  let active = false;
  let started = 0;
  let last = 0;
  let direction = 0;
  let horizontal = 0;
  let vertical = 0;
  let reversal = 0;
  let samples = 0;
  let rejection: string | null = null;
  return {
    begin() {
      active = true;
      started = last = 0;
      direction = horizontal = vertical = reversal = samples = 0;
      rejection = null;
    },
    cancel() {
      active = false;
      rejection = "cancelled";
    },
    isActive() {
      return active;
    },
    snapshot() {
      return {
        active,
        started,
        last,
        direction,
        horizontal,
        vertical,
        reversal,
        samples,
        rejection,
      };
    },
    push(sample: HistorySwipeSample): HistorySwipeDirection | null {
      if (!active) return null;
      const { deltaX, deltaY, time, blocked } = sample;
      if (blocked || ![deltaX, deltaY, time].every(Number.isFinite)) {
        rejection = blocked ? "blocked-surface" : "non-finite-sample";
        active = false;
        return null;
      }
      if (deltaX === 0 && deltaY === 0) return null;
      if (!samples) started = time;
      if ((samples > 0 && time - last > 160) || time < last || time - started > 900) {
        rejection = "sample-timing";
        active = false;
        return null;
      }
      last = time;
      samples += 1;
      vertical += Math.abs(deltaY);
      if (!direction && Math.abs(deltaX) >= 1) direction = Math.sign(deltaX);
      if (direction && deltaX * direction < 0) reversal += Math.abs(deltaX);
      horizontal += deltaX * direction;
      if (reversal >= 24 || (vertical >= 16 && vertical * 2.5 > Math.abs(horizontal))) {
        rejection = reversal >= 24 ? "reversal" : "vertical-movement";
        active = false;
        return null;
      }
      if (samples < 3 || horizontal < 160 || horizontal < vertical * 3) return null;
      active = false;
      return direction < 0 ? "back" : "forward";
    },
    end() {
      active = false;
    },
  };
}

/**
 * Returns why a wheel event belongs to the content instead of history navigation, or null.
 * Mirrors native overscroll navigation: a scroller that can still move in the swipe
 * direction owns the gesture, one already at that edge lets it through. Closed shadow
 * roots are invisible here; their content must preventDefault. Self-contained, since it
 * is also serialized into browser pages: only DOM globals, no module references.
 */
export function historySwipeWheelRejection(
  event: WheelEvent,
  path: readonly EventTarget[],
  boundary: Element | null = null,
): string | null {
  if (
    event.defaultPrevented ||
    event.deltaMode !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    event.buttons !== 0
  )
    return "event-flags-or-prevented";
  for (const target of path) {
    if (!(target instanceof Element)) continue;
    if (
      target.matches(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), canvas, iframe, embed, object",
      )
    )
      return "interactive-surface";
    const style = getComputedStyle(target);
    const viewport = target === document.scrollingElement;
    const range = target.scrollWidth - target.clientWidth;
    const scroller = range > 1 && (viewport || /^(auto|scroll|overlay)$/.test(style.overflowX));
    if (
      (viewport || target === document.body || scroller) &&
      ["contain", "none"].includes(style.overscrollBehaviorX)
    )
      return "overscroll-policy";
    if (scroller && event.deltaX !== 0) {
      const position = style.direction === "rtl" ? target.scrollLeft + range : target.scrollLeft;
      if (event.deltaX < 0 ? position > 1 : position < range - 1) return "horizontal-scroller";
    }
    if (target === boundary) break;
  }
  return null;
}
