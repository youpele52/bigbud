import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import { serviceLeaseGoldenFrames } from "./remoteAgentProtocol.serviceLease.fixture.ts";

const goldens = new Map(
  readFileSync(
    new URL("../../../../protocol/remote-agent/service_lease.golden.frames", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, hex] = line.split("=");
      return [name, Uint8Array.from(Buffer.from(hex!, "hex"))];
    }),
);
it.each(serviceLeaseGoldenFrames)("matches native private lease golden %s", (name, frame) => {
  const encoded = encodeDelimitedFrame(frame);
  expect(encoded).toEqual(goldens.get(name));
  expect(decodeDelimitedFrame(encoded)).toEqual(frame);
});
it("rejects malformed, truncated and multiple private lease payloads", () => {
  const encoded = encodeDelimitedFrame(serviceLeaseGoldenFrames[0]![1]);
  expect(() => decodeDelimitedFrame(encoded.subarray(0, -1))).toThrow();
  expect(() => decodeDelimitedFrame(encoded, 4)).toThrow();
  const doubled = new Uint8Array(4 + (encoded.length - 4) * 2);
  new DataView(doubled.buffer).setUint32(0, doubled.length - 4, false);
  doubled.set(encoded.subarray(4), 4);
  doubled.set(encoded.subarray(4), encoded.length);
  expect(() => decodeDelimitedFrame(doubled)).toThrow("multiple payloads");
});
