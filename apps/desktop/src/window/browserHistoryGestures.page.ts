import type {
  createHistorySwipeRecognizer,
  HistorySwipeSample,
} from "./browserHistoryGestures.logic";

/** Runs only in a private isolated world; no Node, preload, or page-visible bridge. */
export function installBrowserHistoryGestures(
  createRecognizer: typeof createHistorySwipeRecognizer,
  generation: number,
  diagnostics = false,
) {
  const previous = (
    globalThis as typeof globalThis & { __bigbudHistoryGestures?: { generation: number } }
  ).__bigbudHistoryGestures;
  if (previous && previous.generation > generation) return;
  const recognizer = createRecognizer();
  let epoch = 0;
  let lastWheel = -Infinity;
  let pending: HistorySwipeSample | null = null;
  const trace: unknown[] = [];
  const traceDeadline = performance.now() + 120_000;
  let traceRemaining = 600;
  const record = (event: string, details?: unknown) => {
    if (
      !diagnostics ||
      traceRemaining <= 0 ||
      performance.now() >= traceDeadline ||
      trace.length >= 100
    )
      return;
    traceRemaining -= 1;
    trace.push({ event, time: performance.now(), details });
  };
  const cancel = () => {
    epoch += 1;
    pending = null;
    recognizer.cancel();
    record("cancel");
  };
  const onWheel = (event: WheelEvent) => {
    if (diagnostics)
      record("wheel", {
        trusted: event.isTrusted,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        mode: event.deltaMode,
        active: recognizer.isActive(),
      });
    if (!event.isTrusted) return;
    const time = performance.now();
    const first = time - lastWheel >= 250;
    lastWheel = time;
    if (first) pending = null;
    if (!recognizer.isActive() && !first) return;
    const token = epoch;
    const path = event.composedPath();
    // Inspect after propagation so a site's preventDefault wins, without cancelling scrolling.
    queueMicrotask(() => {
      if (token !== epoch) return;
      let blocked =
        event.defaultPrevented ||
        event.deltaMode !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.buttons !== 0;
      let reason = blocked ? "event-flags-or-prevented" : null;
      for (const target of path) {
        if (!(target instanceof Element)) continue;
        const style = getComputedStyle(target);
        const root = target === document.scrollingElement;
        // Scrollable surfaces own the whole gesture, even at their edges.
        // Custom elements may hide a closed shadow scroller; leave them alone.
        if (
          target.matches(
            "input, textarea, select, [contenteditable]:not([contenteditable='false']), canvas, iframe, embed, object",
          ) ||
          target.localName.includes("-") ||
          ["contain", "none"].includes(style.overscrollBehaviorX) ||
          ((root || /^(auto|scroll|overlay)$/.test(style.overflowX)) &&
            target.scrollWidth > target.clientWidth + 1)
        ) {
          blocked = true;
          reason = target.localName.includes("-")
            ? "custom-element"
            : ["contain", "none"].includes(style.overscrollBehaviorX)
              ? "overscroll-policy"
              : target.scrollWidth > target.clientWidth + 1
                ? "horizontal-scroller"
                : "interactive-surface";
          break;
        }
      }
      const sample = {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        time,
        blocked,
      };
      if (recognizer.isActive()) recognizer.push(sample);
      else if (first) pending = sample;
      if (diagnostics) record("sample", { ...sample, first, reason, state: recognizer.snapshot() });
    });
  };
  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("pagehide", cancel);
  const controller = {
    generation,
    drainDiagnostics() {
      return trace.splice(0);
    },
    begin() {
      if (diagnostics)
        record("begin", { pending, pendingAge: pending ? performance.now() - pending.time : null });
      epoch += 1;
      recognizer.begin();
      // Chromium reports scroll begin only after the first wheel is acknowledged.
      // IPC can arm a new phase before its first DOM wheel arrives. An old
      // unarmed/momentum sample must not cancel this genuinely new gesture.
      if (pending && performance.now() - pending.time <= 160) recognizer.push(pending);
      pending = null;
    },
    cancel,
    end() {
      if (diagnostics) record("end-state", recognizer.snapshot());
      const direction = recognizer.end(performance.now());
      record("end-result", { direction });
      recognizer.cancel();
      if (direction === "back") history.back();
      else if (direction === "forward") history.forward();
      return direction;
    },
    destroy() {
      cancel();
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("pagehide", cancel);
    },
  };
  const global = globalThis as typeof globalThis & { __bigbudHistoryGestures?: typeof controller };
  global.__bigbudHistoryGestures?.destroy();
  global.__bigbudHistoryGestures = controller;
}
