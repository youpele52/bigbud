import { describe, expect, it, vi } from "vitest";

import {
  runWsHeartbeatProbe,
  shouldReconnectAfterHeartbeatFailure,
  WS_HEARTBEAT_FAILURE_THRESHOLD,
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
});
