import { describe, expect, it } from "vitest";

import { getWsReconnectDelayMsForRetry } from "./mobileRpc.protocol";

describe("getWsReconnectDelayMsForRetry", () => {
  it("spreads each retry over [cap/2, cap] with the existing exponential caps", () => {
    const caps = [1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000];
    caps.forEach((cap, retryCount) => {
      expect(getWsReconnectDelayMsForRetry(retryCount, () => 0)).toBe(cap / 2);
      expect(getWsReconnectDelayMsForRetry(retryCount, () => 1)).toBe(cap);
      expect(getWsReconnectDelayMsForRetry(retryCount, () => 0.5)).toBe((cap * 3) / 4);
    });
  });

  it("stays bounded even if the random source misbehaves", () => {
    expect(getWsReconnectDelayMsForRetry(3, () => 7)).toBe(8_000);
    expect(getWsReconnectDelayMsForRetry(3, () => -2)).toBe(4_000);
    expect(getWsReconnectDelayMsForRetry(3, () => Number.NaN)).toBeGreaterThanOrEqual(4_000);
  });
});
