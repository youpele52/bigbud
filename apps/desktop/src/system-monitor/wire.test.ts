import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeEvent, encodeCommand, frameBytes } from "./wire";

describe("system monitor wire", () => {
  it("encodes v1 Hello in the same bytes as prost", () => {
    expect([...frameBytes(encodeCommand({ type: "hello" }))]).toEqual([
      0, 0, 0, 6, 10, 4, 8, 1, 16, 3,
    ]);
  });
  it("rejects malformed and oversized output", () => {
    expect(() => decodeEvent(new Uint8Array())).toThrow();
    expect(() => decodeEvent(new Uint8Array(128 * 1024 + 1))).toThrow();
    expect(() => decodeEvent(Uint8Array.of(10, 3, 8))).toThrow();
  });
  it("allows unknown minor fields and decodes handshake", () => {
    const payload = Uint8Array.of(18, 8, 8, 1, 24, 128, 128, 8, 32, 2, 160, 6, 1);
    const event = decodeEvent(payload);
    expect(event).toMatchObject({
      type: "helloAck",
      major: 1,
      maximumFrameBytes: 131072,
      maximumSubscriptions: 2,
    });
  });
  it("decodes optional host identity in the additive HelloAck fields", () => {
    const ack = Uint8Array.of(
      8,
      1,
      16,
      1,
      24,
      128,
      128,
      8,
      32,
      2,
      40,
      1,
      58,
      4,
      104,
      111,
      115,
      116,
      66,
      5,
      109,
      97,
      99,
      79,
      83,
      74,
      4,
      49,
      53,
      46,
      48,
      82,
      5,
      97,
      114,
      109,
      54,
      52,
    );
    const event = decodeEvent(Uint8Array.of(18, ack.length, ...ack));
    expect(event).toMatchObject({
      type: "helloAck",
      minor: 1,
      hostname: "host",
      osName: "macOS",
      osVersion: "15.0",
      architecture: "arm64",
    });
  });
  it("preserves a full uint64 process cursor digest", () => {
    const event = decodeEvent(
      Uint8Array.of(74, 13, 8, 1, 40, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1),
    );
    expect(event).toMatchObject({
      type: "processPage",
      page: { nextDigest: "18446744073709551615" },
    });
  });
  it("decodes an explicit Retry acknowledgement", () => {
    expect(decodeEvent(Uint8Array.of(114, 4, 8, 1, 16, 2))).toEqual({
      type: "retryAck",
      requestId: 1,
      epoch: 2,
    });
  });
  it("decodes Rust collection retry status as a typed event", () => {
    expect(
      decodeEvent(Uint8Array.of(122, 14, 8, 2, 16, 1, 24, 232, 7, 34, 3, 99, 112, 117, 40, 9)),
    ).toEqual({
      type: "collectionStatus",
      status: { state: "retrying", attempts: 1, retryAfterMs: 1000, reason: "cpu", epoch: 9 },
    });
  });
  it("decodes an added snapshot metric without changing v1 framing", () => {
    const event = decodeEvent(
      Uint8Array.of(
        50,
        36,
        8,
        1,
        16,
        2,
        24,
        3,
        194,
        1,
        7,
        18,
        5,
        114,
        101,
        97,
        100,
        121,
        202,
        1,
        7,
        18,
        5,
        114,
        101,
        97,
        100,
        121,
        242,
        1,
        7,
        18,
        5,
        114,
        101,
        97,
        100,
        121,
      ),
    );
    expect(event).toMatchObject({
      type: "snapshot",
      snapshot: {
        uptimeSeconds: { status: "ready" },
        logicalCores: { status: "ready" },
        memoryAvailableBytes: { status: "ready" },
      },
    });
  });
  it("decodes the shared Rust frames for snapshot, page, and error", () => {
    const text = readFileSync(
      new URL("../../../../protocol/system-monitor/fixtures/v1.frames", import.meta.url),
      "utf8",
    );
    const fixtures = Object.fromEntries(
      text
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    const frame = (name: string) => {
      const hex = fixtures[name] as string;
      const bytes = Uint8Array.from(
        (hex.match(/../g) ?? []).map((part: string) => Number.parseInt(part, 16)),
      );
      return decodeEvent(bytes.subarray(4));
    };
    expect(
      [...frameBytes(encodeCommand({ type: "hello", minor: 2 }))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    ).toBe(fixtures.hello);
    const query = encodeCommand({
      type: "query",
      requestId: 4,
      query: { sort: "cpu", descending: true, limit: 10 },
    });
    expect([...frameBytes(query)].map((byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
      fixtures.process_query,
    );
    expect(
      [
        ...encodeCommand({
          type: "query",
          requestId: 4,
          query: { search: "run", sort: "cpu", descending: true, limit: 10 },
        }),
      ].slice(-5),
    ).toEqual([0x5a, 3, 0x72, 0x75, 0x6e]);
    expect(frame("snapshot")).toMatchObject({
      type: "snapshot",
      snapshot: { subscriptionId: 1, epoch: 2, sequence: 3, hostname: "host" },
    });
    expect(frame("process_page")).toMatchObject({
      type: "processPage",
      page: { nextDigest: "18446744073709551615" },
    });
    expect(frame("error")).toMatchObject({
      type: "error",
      error: { code: "stale-query", message: "expired" },
    });
    expect(frame("collection_status")).toMatchObject({
      type: "collectionStatus",
      status: { state: "retrying", retryAfterMs: 1000 },
    });
  });
});
