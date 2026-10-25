import { describe, expect, it, vi } from "vitest";

import {
  getWsReconnectBackoffCeilingMs,
  getWsReconnectDelayMs,
  WS_RECONNECT_INITIAL_DELAY_MS,
  WS_RECONNECT_MAX_DELAY_MS,
  WsReconnectBackoff,
} from "./wsReconnectPolicy";

describe("unbounded reconnect policy", () => {
  it("grows exponentially from 1 s and caps at 30 s for any number of retries", () => {
    expect(getWsReconnectBackoffCeilingMs(0)).toBe(WS_RECONNECT_INITIAL_DELAY_MS);
    expect(getWsReconnectBackoffCeilingMs(1)).toBe(2_000);
    expect(getWsReconnectBackoffCeilingMs(4)).toBe(16_000);
    expect(getWsReconnectBackoffCeilingMs(5)).toBe(WS_RECONNECT_MAX_DELAY_MS);
    for (const retryIndex of [7, 8, 50, 10_000, Number.MAX_SAFE_INTEGER]) {
      expect(getWsReconnectBackoffCeilingMs(retryIndex)).toBe(WS_RECONNECT_MAX_DELAY_MS);
    }
  });

  it("applies full jitter within [0, ceiling]", () => {
    for (const retryIndex of [0, 3, 6, 100]) {
      const ceiling = getWsReconnectBackoffCeilingMs(retryIndex);
      expect(getWsReconnectDelayMs(retryIndex, () => 0)).toBe(0);
      expect(getWsReconnectDelayMs(retryIndex, () => 1)).toBe(ceiling);
      expect(getWsReconnectDelayMs(retryIndex, () => 0.5)).toBe(Math.round(ceiling / 2));
      for (let sample = 0; sample < 50; sample += 1) {
        const delay = getWsReconnectDelayMs(retryIndex);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
    // Out-of-range random sources are clamped instead of escaping the bounds.
    expect(getWsReconnectDelayMs(0, () => 7)).toBe(WS_RECONNECT_INITIAL_DELAY_MS);
    expect(getWsReconnectDelayMs(0, () => -1)).toBe(0);
  });

  it("keeps producing delays past the old eight-attempt cap and resets on open", () => {
    const backoff = new WsReconnectBackoff(() => 1);
    const delays = Array.from({ length: 12 }, () => backoff.nextDelayMs());
    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
    ]);
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(1_000);
  });

  it("lets a wake signal cut the current wait short and restart the ladder", async () => {
    vi.useFakeTimers();
    try {
      const backoff = new WsReconnectBackoff(() => 1);
      backoff.nextDelayMs();
      backoff.nextDelayMs();
      const resolved = vi.fn();
      void backoff.sleep(30_000).then(resolved);
      expect(backoff.isWaiting).toBe(true);
      backoff.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toHaveBeenCalledOnce();
      expect(backoff.isWaiting).toBe(false);
      expect(backoff.nextDelayMs()).toBe(1_000);

      // A wake between waits skips the next wait once.
      backoff.wake();
      const skipped = vi.fn();
      void backoff.sleep(30_000).then(skipped);
      await vi.advanceTimersByTimeAsync(0);
      expect(skipped).toHaveBeenCalledOnce();
      const normal = vi.fn();
      void backoff.sleep(30_000).then(normal);
      await vi.advanceTimersByTimeAsync(0);
      expect(normal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(normal).toHaveBeenCalledOnce();

      // Opening a socket clears an armed wake.
      backoff.wake();
      backoff.reset();
      const afterReset = vi.fn();
      void backoff.sleep(1_000).then(afterReset);
      await vi.advanceTimersByTimeAsync(0);
      expect(afterReset).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a wait on abort without leaking sleepers", async () => {
    const backoff = new WsReconnectBackoff();
    const controller = new AbortController();
    const sleeping = backoff.sleep(60_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(backoff.isWaiting).toBe(false);
  });
});
