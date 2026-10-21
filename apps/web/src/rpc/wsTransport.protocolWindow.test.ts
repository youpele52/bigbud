import { describe, expect, it } from "vitest";

import {
  resolveWsProtocolRecoveryDelayMs,
  WS_PROTOCOL_FAILURE_WINDOW_MS,
  WsProtocolFailureWindow,
} from "./wsTransport.protocolWindow";
import { WS_RECONNECT_MAX_DELAY_MS } from "./wsReconnectPolicy";

describe("sliding protocol failure window", () => {
  it("counts only failures inside the last 30 s", () => {
    let now = 0;
    const window = new WsProtocolFailureWindow(WS_PROTOCOL_FAILURE_WINDOW_MS, () => now);
    expect(window.record()).toBe(1);
    now = 10_000;
    expect(window.record()).toBe(2);
    now = 20_000;
    expect(window.record()).toBe(3);
    now = 31_000;
    // The failure at 0 s slid out of the window.
    expect(window.record()).toBe(3);
    now = 70_000;
    expect(window.record()).toBe(1);
    window.reset();
    expect(window.record()).toBe(1);
  });

  it("keeps the gentle ladder below the escalation threshold", () => {
    expect(resolveWsProtocolRecoveryDelayMs(1)).toBe(250);
    expect(resolveWsProtocolRecoveryDelayMs(2)).toBe(500);
  });

  it("backs off harder once escalated, never to zero and never past the cap", () => {
    for (const failures of [3, 4, 6, 20, 1_000]) {
      const low = resolveWsProtocolRecoveryDelayMs(failures, () => 0);
      const high = resolveWsProtocolRecoveryDelayMs(failures, () => 1);
      expect(low).toBeGreaterThan(500);
      expect(high).toBeGreaterThanOrEqual(low);
      expect(high).toBeLessThanOrEqual(WS_RECONNECT_MAX_DELAY_MS);
    }
    expect(resolveWsProtocolRecoveryDelayMs(1_000, () => 1)).toBe(WS_RECONNECT_MAX_DELAY_MS);
  });
});
