import { describe, expect, it, vi } from "vitest";

import {
  runWsHeartbeatProbe,
  shouldReconnectAfterHeartbeatFailure,
  WS_HEARTBEAT_FAILURE_THRESHOLD,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_TIMEOUT_MS,
} from "./wsHeartbeat";

describe("runWsHeartbeatProbe", () => {
  it("reports a responsive server as healthy", async () => {
    await expect(runWsHeartbeatProbe(async () => ({ serverTime: "now" }), 10)).resolves.toBe(true);
  });

  it("reports a stale-open request after its bounded timeout", async () => {
    vi.useFakeTimers();
    const probe = runWsHeartbeatProbe(() => new Promise(() => undefined), 15);
    await vi.advanceTimersByTimeAsync(15);
    await expect(probe).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("requires repeated probe failures before replacing a stale-open socket", () => {
    expect(shouldReconnectAfterHeartbeatFailure(WS_HEARTBEAT_FAILURE_THRESHOLD - 1)).toBe(false);
    expect(shouldReconnectAfterHeartbeatFailure(WS_HEARTBEAT_FAILURE_THRESHOLD)).toBe(true);
  });

  it("uses the approved D5 thresholds so a silent dead socket is found within about 20 s", () => {
    expect(WS_HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(WS_HEARTBEAT_TIMEOUT_MS).toBe(10_000);
    expect(WS_HEARTBEAT_FAILURE_THRESHOLD).toBe(2);
    expect(shouldReconnectAfterHeartbeatFailure(1)).toBe(false);
    expect(shouldReconnectAfterHeartbeatFailure(2)).toBe(true);
  });

  it("times out a probe at 10 s by default", async () => {
    vi.useFakeTimers();
    try {
      const probe = runWsHeartbeatProbe(() => new Promise(() => undefined));
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_TIMEOUT_MS - 1);
      let settled = false;
      void probe.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(probe).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
