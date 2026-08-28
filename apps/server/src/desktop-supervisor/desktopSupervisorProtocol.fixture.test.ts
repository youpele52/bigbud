import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  computeDesktopSupervisorBatchId,
  decodeDesktopSupervisorDelimitedFrame,
  encodeDesktopSupervisorDelimitedFrame,
} from "./desktopSupervisorProtocol.codec.ts";
import { DEFAULT_DESKTOP_SUPERVISOR_LIMITS } from "./desktopSupervisorProtocol.ts";

const fixturePath = fileURLToPath(
  new URL("../../../../protocol/desktop-supervisor/fixtures/v1.frames", import.meta.url),
);
const fixtures = new Map(
  readFileSync(fixturePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("=", 2) as [string, string]),
);
const hex = (name: string) => Buffer.from(fixtures.get(name)!, "hex");

describe("desktop supervisor cross-language fixtures", () => {
  it("matches the canonical hello and batch identity vectors", () => {
    expect(
      Buffer.from(
        encodeDesktopSupervisorDelimitedFrame({
          type: "clientHello",
          value: {
            protocolMajor: 1,
            protocolMinor: 1,
            clientInstanceId: "client-fixture",
            requestedLimits: DEFAULT_DESKTOP_SUPERVISOR_LIMITS,
          },
        }),
      ),
    ).toEqual(hex("hello"));
    const identity = {
      serverEpoch: "epoch-fixture",
      subscriptionGeneration: 7,
      consumerId: "consumer-fixture",
      consumerGeneration: 7,
      events: [
        {
          eventId: "event-fixture",
          sequence: 42,
          canonicalPayload: new TextEncoder().encode('{"fixture":true}'),
        },
      ],
    };
    expect(computeDesktopSupervisorBatchId(identity)).toBe(fixtures.get("batch_id"));
    expect(
      Buffer.from(
        encodeDesktopSupervisorDelimitedFrame({
          type: "eventBatch",
          value: { ...identity, batchId: fixtures.get("batch_id")! },
        }),
      ),
    ).toEqual(hex("batch"));
  });

  it.each([
    ["hello", "clientHello"],
    ["attach", "attachConsumer"],
    ["batch", "eventBatch"],
    ["ack", "applicationAck"],
    ["ack_accepted", "applicationAckAccepted"],
    ["recovery", "recoveryRequired"],
    ["error", "protocolError"],
  ])("decodes the %s fixture", (name, type) => {
    expect(decodeDesktopSupervisorDelimitedFrame(hex(name)).type).toBe(type);
  });

  it("rejects a truncated fixture", () => {
    expect(() => decodeDesktopSupervisorDelimitedFrame(hex("truncated"))).toThrow(
      "frame length does not match prefix",
    );
  });
});
