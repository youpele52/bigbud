import { describe, expect, it, vi } from "vitest";

import { runWithAbortableDeadline } from "./Adapter.requestDeadline.ts";

describe("runWithAbortableDeadline", () => {
  it("rejects at the outer deadline when the SDK ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const operation = runWithAbortableDeadline({
      operation: "OpenCode test request",
      timeoutMs: 100,
      run: (requestSignal) => {
        signal = requestSignal;
        return new Promise(() => undefined);
      },
    });

    const assertion = expect(operation).rejects.toThrow("timed out after 100ms");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
