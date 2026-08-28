import { describe, expect, it } from "vitest";

import {
  getWsInboundActivitySequence,
  hasWsInboundActivitySince,
  markWsInboundActivity,
} from "./wsActivity";

describe("WebSocket inbound activity", () => {
  it("detects activity after a heartbeat probe starts", () => {
    const sequence = getWsInboundActivitySequence();
    markWsInboundActivity();
    expect(hasWsInboundActivitySince(sequence)).toBe(true);
  });

  it("does not report activity before the sequence advances", () => {
    const sequence = getWsInboundActivitySequence();
    expect(hasWsInboundActivitySince(sequence)).toBe(false);
  });
});
