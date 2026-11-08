import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ORGANIZATION_LIMITS, type OrganizationFrame } from "./organizationProtocol.ts";
import { decodeOrganizationFrame } from "./organizationProtocol.decode.ts";
import { encodeOrganizationFrame } from "./organizationProtocol.encode.ts";
import { fixtureFrames, fixtureRow } from "./organizationProtocol.fixtures.ts";
import { encodeCompactSnapshot } from "./organizationSnapshot.ts";

const epoch = { backendNonce: "backend", generation: 7 };
const begin = {
  snapshotId: "small",
  sequence: 10,
  sourceFrontier: 100,
  policy: { version: 2, fingerprint: "policy" },
};
const limits = {
  ...ORGANIZATION_LIMITS,
  pageRows: 1,
  frameBytes: 128,
  liveRows: 2,
  stateBytes: 256,
};
function golden(name: string) {
  return readFileSync(
    new URL(`../../../../protocol/thread-organization/${name}.hex`, import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n");
}
it("honors reduced negotiated row/frame/state limits in a shared Rust fixture", () => {
  const hello = fixtureFrames()[0]!;
  if (hello.type !== "hello") throw new Error("hello");
  const frames = [
    { ...hello, value: { ...hello.value, limits } },
    ...encodeCompactSnapshot(
      epoch,
      begin,
      [fixtureRow, { ...fixtureRow, threadId: "thread-b" }],
      limits,
    ),
  ];
  expect(
    frames.map((frame) => Buffer.from(encodeOrganizationFrame(frame, limits)).toString("hex")),
  ).toEqual(golden("reduced-limits-fixture"));
  expect(
    frames.filter((frame) => frame.type === "page").map((frame) => frame.value.rows.length),
  ).toEqual([1, 1]);
});
it("rejects invalid limits and preflights begin/page/end without a successful end", () => {
  for (const selected of [
    { ...limits, pageRows: 0 },
    { ...limits, pageRows: 0.5 },
    { ...limits, liveRows: 1 },
    { ...limits, stateBytes: 1 },
    { ...limits, frameBytes: 1 },
  ]) {
    const observed: OrganizationFrame[] = [];
    expect(() => {
      for (const frame of encodeCompactSnapshot(
        epoch,
        begin,
        [fixtureRow, { ...fixtureRow, threadId: "thread-b" }],
        selected,
      ))
        observed.push(frame);
    }).toThrow();
    expect(observed.some((frame) => frame.type === "end")).toBe(false);
  }
  // Begin fits, but SHA-256 end does not; no unchecked terminal frame escapes.
  const observed: OrganizationFrame[] = [];
  expect(() => {
    for (const frame of encodeCompactSnapshot(epoch, begin, [], { ...limits, frameBytes: 45 }))
      observed.push(frame);
  }).toThrow();
  expect(observed.map((frame) => frame.type)).toEqual(["begin"]);
  expect(() =>
    encodeOrganizationFrame(fixtureFrames()[0]!, { ...limits, frameBytes: 10 }),
  ).toThrow();
});
it("rejects the shared nested duplicate corpus while allowing repeated rows/unknown fields", () => {
  for (const line of golden("malformed-duplicates"))
    expect(() => decodeOrganizationFrame(Buffer.from(line, "hex"))).toThrow();
  const hello = encodeOrganizationFrame(fixtureFrames()[0]!);
  expect(
    decodeOrganizationFrame(new Uint8Array([...hello, 0x98, 0x06, 1, 0x98, 0x06, 2])).type,
  ).toBe("hello");
  const pages = [
    ...encodeCompactSnapshot(epoch, begin, [fixtureRow, { ...fixtureRow, threadId: "thread-b" }]),
  ];
  expect(
    pages
      .filter((frame) => frame.type === "page")
      .map((frame) => decodeOrganizationFrame(encodeOrganizationFrame(frame))),
  ).toHaveLength(1);
});
