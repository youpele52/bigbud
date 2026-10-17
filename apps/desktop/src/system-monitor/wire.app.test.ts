import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeEvent, encodeCommand, frameBytes } from "./wire";
import { decodeAppResources } from "./wire.app";

const fixtures = Object.fromEntries(
  readFileSync(
    new URL("../../../../protocol/system-monitor/fixtures/v1.3.frames", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => line.split("=")),
);

describe("additive app-resource wire contract", () => {
  it("encodes trusted roots identically to the Rust schema", () => {
    const bytes = frameBytes(
      encodeCommand({
        type: "subscribe",
        requestId: 1,
        demand: { processes: false, disks: false, sensors: false, appResources: true },
        roots: [{ pid: 42, identity: "owned:42", startTimeSeconds: 123, role: "desktop" }],
      }),
    );
    expect(Buffer.from(bytes).toString("hex")).toBe(fixtures.app_subscribe);
  });
  it("decodes the Rust aggregate before any process pagination", () => {
    const event = decodeEvent(Buffer.from(fixtures.app_snapshot!, "hex").subarray(4));
    expect(event).toMatchObject({
      type: "snapshot",
      snapshot: {
        appResources: {
          generation: 1,
          sampledAtMs: 1000,
          incomplete: false,
          core: { processCount: 3, cpuPercent: { value: 4.8, status: "ready" } },
          inclusive: { processCount: 4, cpuPercent: { value: 18.4, status: "ready" } },
          groups: expect.arrayContaining([expect.objectContaining({ role: "tools" })]),
        },
      },
    });
  });
  it("rejects missing aggregates and oversized input registries", () => {
    expect(() => decodeAppResources(new Uint8Array())).toThrow("summary");
    expect(() =>
      encodeCommand({
        type: "subscribe",
        requestId: 1,
        demand: { processes: false, disks: false, sensors: false, appResources: true },
        roots: Array.from({ length: 129 }, (_, pid) => ({
          pid: pid + 1,
          identity: String(pid),
          role: "desktop" as const,
        })),
      }),
    ).toThrow("too many");
  });
});
