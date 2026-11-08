import { describe, expect, it } from "vitest";
import {
  OrganizationFrameReader,
  organizationDelimitedFrame,
} from "./organizationNative.framing.ts";

describe("organisation framed transport", () => {
  it("decodes every prefix/payload split and multiple adjacent frames", () => {
    const payload = Buffer.from("bounded organisation facts");
    const encoded = Buffer.concat([
      organizationDelimitedFrame(payload),
      organizationDelimitedFrame(payload),
    ]);
    for (let split = 0; split <= encoded.length; split++) {
      const reader = new OrganizationFrameReader();
      const output: Uint8Array[] = [];
      reader.push(encoded.subarray(0, split), (frame) => output.push(frame));
      reader.push(encoded.subarray(split), (frame) => output.push(frame));
      reader.end();
      expect(output.map((frame) => Buffer.from(frame).toString())).toEqual([
        payload.toString(),
        payload.toString(),
      ]);
    }
  });

  it("rejects invalid prefixes before accepting any payload", () => {
    for (const size of [0, 17, 0xffffffff]) {
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(size);
      expect(() => new OrganizationFrameReader(16).push(prefix, () => {})).toThrow("length");
    }
    expect(() => organizationDelimitedFrame(Buffer.alloc(0))).toThrow("size");
  });

  it("rejects EOF in every incomplete frame and permits an empty stream", () => {
    const bytes = organizationDelimitedFrame(Buffer.from("hello"));
    new OrganizationFrameReader().end();
    for (let size = 1; size < bytes.length; size++) {
      const reader = new OrganizationFrameReader();
      reader.push(bytes.subarray(0, size), () => {});
      expect(() => reader.end()).toThrow("truncated");
    }
  });

  it("does not retain a completed frame when the receiver refuses it", () => {
    const reader = new OrganizationFrameReader();
    expect(() =>
      reader.push(organizationDelimitedFrame(Buffer.from("x")), () => {
        throw new Error("fenced");
      }),
    ).toThrow("fenced");
    expect(() => reader.end()).not.toThrow();
  });
});
