import type { OpenCodeEvent } from "@opencode/client";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";

/** Live-only SSE: marker/activity loss aborts this source; never infers native completion. */
export async function* checkedV2EventConnection(input: {
  subscribe: (signal: AbortSignal, activity?: () => void) => AsyncIterable<OpenCodeEvent>;
  signal: AbortSignal;
  markerTimeoutMs?: number;
  idleTimeoutMs?: number;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let connected = false;
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(),
      connected ? (input.idleTimeoutMs ?? 45000) : (input.markerTimeoutMs ?? 2000),
    );
    timer.unref();
  };
  // Activity cannot indefinitely postpone the required first marker.
  touch();
  const source = input.subscribe(signal, () => {
    if (connected) touch();
  });
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      const item = await runWithAbortableDeadline({
        operation: "V2 event source activity",
        timeoutMs: 24 * 60 * 60 * 1000,
        signal,
        run: () => iterator.next(),
      });
      if (signal.aborted) return;
      if (item.done) return;
      if (!connected) {
        if (
          item.value.type !== "server.connected" ||
          typeof item.value.id !== "string" ||
          !item.value.id ||
          !item.value.data ||
          typeof item.value.data !== "object"
        )
          throw new Error("V2 event source missing initial server.connected.");
        connected = true;
      }
      touch();
      yield item.value;
    }
  } finally {
    clearTimeout(timer!);
    controller.abort();
    void iterator.return?.().catch(() => {});
  }
}
