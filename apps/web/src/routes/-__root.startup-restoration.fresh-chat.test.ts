import { describe, expect, it, vi } from "vitest";

import { runCoalescedStartupFreshChat } from "./-__root.startup-restoration";

type InFlight = { promise: Promise<void>; runId: number } | null;

describe("startup fresh-chat coalescing", () => {
  it("starts once for concurrent callers from the same run", async () => {
    let resolveFirst!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const start = vi.fn().mockReturnValue(firstAttempt);
    const inFlight = { current: null as InFlight };

    const first = runCoalescedStartupFreshChat({
      inFlight,
      isCurrent: () => true,
      runId: 1,
      start,
    });
    const concurrent = runCoalescedStartupFreshChat({
      inFlight,
      isCurrent: () => true,
      runId: 1,
      start,
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    resolveFirst();
    await Promise.all([first, concurrent]);

    expect(inFlight.current).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("retries a newer current run after an older run goes stale", async () => {
    let currentRun = 1;
    let resolveOld!: () => void;
    const oldAttempt = new Promise<void>((resolve) => {
      resolveOld = resolve;
    });
    const oldStart = vi.fn(() => oldAttempt);
    const newStart = vi.fn(async () => undefined);
    const inFlight = { current: null as InFlight };
    const oldRun = runCoalescedStartupFreshChat({
      inFlight,
      isCurrent: () => currentRun === 1,
      runId: 1,
      start: oldStart,
    });
    await vi.waitFor(() => expect(oldStart).toHaveBeenCalledTimes(1));

    currentRun = 2;
    const newRun = runCoalescedStartupFreshChat({
      inFlight,
      isCurrent: () => currentRun === 2,
      runId: 2,
      start: newStart,
    });
    resolveOld();
    await Promise.all([oldRun, newRun]);

    expect(newStart).toHaveBeenCalledTimes(1);
  });

  it("retries a newer current run after an older attempt rejects", async () => {
    let currentRun = 1;
    let rejectOld!: (error: Error) => void;
    const oldAttempt = new Promise<void>((_resolve, reject) => {
      rejectOld = reject;
    });
    const newStart = vi.fn(async () => undefined);
    const inFlight = { current: null as InFlight };
    const oldRun = runCoalescedStartupFreshChat({
      inFlight,
      isCurrent: () => currentRun === 1,
      runId: 1,
      start: () => oldAttempt,
    });
    await vi.waitFor(() => expect(inFlight.current?.runId).toBe(1));

    currentRun = 2;
    const newRun = runCoalescedStartupFreshChat({
      inFlight,
      isCurrent: () => currentRun === 2,
      runId: 2,
      start: newStart,
    });
    rejectOld(new Error("old failed"));

    await expect(oldRun).rejects.toThrow("old failed");
    await expect(newRun).resolves.toBeUndefined();
    expect(newStart).toHaveBeenCalledTimes(1);
  });
});
