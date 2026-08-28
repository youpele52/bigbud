import { describe, expect, it, vi } from "vitest";

import { runWsHeartbeatProbe } from "./wsHeartbeat";

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
});
