import type {
  createHistorySwipeRecognizer,
  HistorySwipeDirection,
  HistorySwipeSample,
  historySwipeWheelRejection,
} from "@bigbud/shared/historySwipe";

/** Runs only in a private isolated world; no Node, preload, or page-visible bridge. */
export function installBrowserHistoryGestures(
  createRecognizer: typeof createHistorySwipeRecognizer,
  wheelRejection: typeof historySwipeWheelRejection,
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
  let committed: HistorySwipeDirection | null = null;
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
  const navigate = (direction: HistorySwipeDirection | null) => {
    if (!direction) return;
    committed = direction;
    record("commit", { direction });
    if (direction === "back") history.back();
    else history.forward();
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
      const reason = wheelRejection(event, path);
      const sample = {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        time,
        blocked: reason !== null,
      };
      if (recognizer.isActive()) navigate(recognizer.push(sample));
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
      committed = null;
      recognizer.begin();
      // Chromium reports scroll begin only after the first wheel is acknowledged.
      // IPC can arm a new phase before its first DOM wheel arrives. An old
      // unarmed/momentum sample must not cancel this genuinely new gesture.
      if (pending && performance.now() - pending.time <= 160) navigate(recognizer.push(pending));
      pending = null;
    },
    cancel,
    // Reports whether this native phase already navigated, so the host keeps its cooldown.
    end() {
      if (diagnostics) record("end-state", recognizer.snapshot());
      recognizer.end();
      const direction = committed;
      committed = null;
      record("end-result", { direction });
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
