import { describe, expect, it } from "vitest";

import { cappedExponentialRetryDelay, resolveSubscriptionRetryDelayMs } from "./wsTransport.retry";

describe("WebSocket subscription retry delay", () => {
  it("calculates deterministic capped exponential backoff", () => {
    expect(
      Array.from({ length: 8 }, (_, index) =>
        cappedExponentialRetryDelay({ attempt: index + 1, baseMs: 250, maxMs: 8_000 }),
      ),
    ).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it("keeps static delays backward compatible and resolves dynamic context", () => {
    expect(
      resolveSubscriptionRetryDelayMs(125, { error: new Error("static"), attempt: 4 }, 250),
    ).toBe(125);
    expect(
      resolveSubscriptionRetryDelayMs(
        ({ attempt }) => attempt * 100,
        { error: new Error("dynamic"), attempt: 3 },
        250,
      ),
    ).toBe(300);
    expect(resolveSubscriptionRetryDelayMs(undefined, { error: null, attempt: 1 }, 250)).toBe(250);
  });
});
