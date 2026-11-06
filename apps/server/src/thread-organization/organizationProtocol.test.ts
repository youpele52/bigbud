import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ORGANIZATION_MAX_FRAME_BYTES, type OrganizationFrame } from "./organizationProtocol.ts";
import {
  decodeOrganizationDelimitedFrame,
  decodeOrganizationFrame,
} from "./organizationProtocol.decode.ts";
import {
  encodeOrganizationDelimitedFrame,
  encodeOrganizationFrame,
} from "./organizationProtocol.encode.ts";
import { fixtureFrames, fixtureRow } from "./organizationProtocol.fixtures.ts";
import { encodeCompactSnapshot } from "./organizationSnapshot.ts";

const epoch = { backendNonce: "backend", generation: 7 };
const begin = {
  snapshotId: "snapshot",
  sequence: 10,
  sourceFrontier: 100,
  policy: { version: 2, fingerprint: "policy" },
};

describe("organisation compact protobuf", () => {
  it("matches the shared Rust snapshot/live suffix golden and preserves optional zero", () => {
    const golden = readFileSync(
      new URL("../../../../protocol/thread-organization/snapshot-fixture.hex", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n");
    const frames = fixtureFrames();
    expect(frames).toHaveLength(golden.length);
    frames.forEach((frame, index) => {
      const encoded = encodeOrganizationFrame(frame);
      expect(Buffer.from(encoded).toString("hex")).toBe(golden[index]);
      expect(decodeOrganizationFrame(encoded)).toEqual(frame);
      expect(decodeOrganizationDelimitedFrame(encodeOrganizationDelimitedFrame(frame))).toEqual(
        frame,
      );
    });
  });

  it("rejects truncated, oversized, empty, unsafe and ambiguous frames", () => {
    for (const bytes of [new Uint8Array(), Uint8Array.of(0xff), Uint8Array.of(0x0a, 0xff)])
      expect(() => decodeOrganizationFrame(bytes)).toThrow();
    const valid = encodeOrganizationDelimitedFrame(fixtureFrames()[0]!);
    for (let prefix = 0; prefix < valid.length; prefix += 1)
      expect(() => decodeOrganizationDelimitedFrame(valid.subarray(0, prefix))).toThrow();
    expect(() =>
      decodeOrganizationFrame(new Uint8Array(ORGANIZATION_MAX_FRAME_BYTES + 1)),
    ).toThrow();
    expect(() => decodeOrganizationDelimitedFrame(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toThrow();
    const hello = encodeOrganizationFrame(fixtureFrames()[0]!);
    expect(() => decodeOrganizationFrame(new Uint8Array([...hello, ...hello]))).toThrow();
    expect(() =>
      encodeOrganizationFrame({ ...fixtureFrames()[0]!, generation: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() =>
      decodeOrganizationFrame(
        Uint8Array.of(0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f),
      ),
    ).toThrow();
  });

  it("pages stably at 256 rows, keeps policy version, and does not mutate prior pages", () => {
    const rows = Array.from({ length: 513 }, (_, i) => ({
      ...fixtureRow,
      threadId: `thread-${i.toString().padStart(4, "0")}`,
    }));
    const frames = [...encodeCompactSnapshot(epoch, begin, rows)];
    expect(
      frames.filter((frame) => frame.type === "page").map((frame) => frame.value.rows.length),
    ).toEqual([256, 256, 1]);
    expect(frames.at(-1)).toMatchObject({
      type: "end",
      value: { pages: 3, rows: 513, policyVersion: 2 },
    });
    for (const frame of frames)
      expect(decodeOrganizationFrame(encodeOrganizationFrame(frame))).toEqual(frame);
  });

  it("rejects unordered/duplicate rows and interrupted source before emitting an end", () => {
    for (const rows of [
      [fixtureRow, fixtureRow],
      [{ ...fixtureRow, threadId: "z" }, fixtureRow],
    ]) {
      const observed: OrganizationFrame[] = [];
      expect(() => {
        for (const frame of encodeCompactSnapshot(epoch, begin, rows)) observed.push(frame);
      }).toThrow();
      expect(observed.some((frame) => frame.type === "end")).toBe(false);
    }
    function* interrupted() {
      yield fixtureRow;
      throw new Error("source failed");
    }
    const observed: OrganizationFrame[] = [];
    expect(() => {
      for (const frame of encodeCompactSnapshot(epoch, begin, interrupted())) observed.push(frame);
    }).toThrow("source failed");
    expect(observed.some((frame) => frame.type === "end")).toBe(false);
  });

  it("row capacity overflow never emits a truncated successful end", () => {
    function* tooManyRows() {
      for (let i = 0; i <= 100_000; i += 1)
        yield { ...fixtureRow, threadId: `thread-${i.toString().padStart(6, "0")}` };
    }
    let ended = false;
    expect(() => {
      for (const frame of encodeCompactSnapshot(epoch, begin, tooManyRows()))
        if (frame.type === "end") ended = true;
    }).toThrow("capacity");
    expect(ended).toBe(false);
  });

  it("empty snapshot has SHA-256 of empty input and no empty page", () => {
    const frames = [...encodeCompactSnapshot(epoch, begin, [])];
    expect(frames).toHaveLength(2);
    const end = frames.at(-1);
    if (end?.type !== "end") throw new Error("missing end");
    expect(Buffer.from(end.value.digest).toString("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("byte-preflights oversized pages rather than truncating the global snapshot", () => {
    // Large synthetic identity is malformed for admission, but exercises the
    // encoder's independent wire-byte bound without allocating >100k rows.
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...fixtureRow,
      threadId: `a${i}`,
      snoozeIdentity: "x".repeat(400_000),
    }));
    const frames = [...encodeCompactSnapshot(epoch, begin, rows)];
    expect(
      frames.filter((frame) => frame.type === "page").map((frame) => frame.value.rows.length),
    ).toEqual([2, 1]);
    for (const frame of frames)
      expect(encodeOrganizationFrame(frame).length).toBeLessThanOrEqual(
        ORGANIZATION_MAX_FRAME_BYTES,
      );
    expect(() => [
      ...encodeCompactSnapshot(epoch, begin, [
        { ...fixtureRow, snoozeIdentity: "x".repeat(ORGANIZATION_MAX_FRAME_BYTES) },
      ]),
    ]).toThrow();
  });
});

it("round-trips in-place policy frames and automatic placement facts", () => {
  const frames: OrganizationFrame[] = [
    {
      ...epoch,
      type: "policy",
      value: {
        version: 3,
        fingerprint: "policy-3",
        olderPolicyChangedAtMs: 0,
        scheduling: {
          idleEnabled: true,
          idleTimeoutMs: 600000,
          idleDestination: 3,
          olderEnabled: false,
          olderTimeoutMs: 86400000,
          presentTarget: 7,
          targetNotBeforeMs: 5,
          graceMs: 300000,
        },
      },
    },
    {
      ...epoch,
      type: "fact",
      value: {
        sequence: 11,
        sourceFrontier: 100,
        row: { ...fixtureRow, section: 1, automaticPlacement: true },
        deleted: false,
      },
    },
    {
      ...epoch,
      type: "fact",
      value: {
        sequence: 12,
        sourceFrontier: 100,
        row: { ...fixtureRow, section: 1, automaticPlacement: false },
        deleted: false,
      },
    },
  ];
  for (const frame of frames)
    expect(decodeOrganizationFrame(encodeOrganizationFrame(frame))).toEqual(frame);
});
