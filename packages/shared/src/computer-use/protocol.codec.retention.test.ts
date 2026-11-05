import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeComputerUseFrame, encodeComputerUseFrame } from "./protocol.codec";
import {
  messageFields,
  type ComputerUseFrame,
  type MessageKind,
  type WireRecord,
} from "./protocol.fields";

const golden = new Map(
  readFileSync(
    new URL("../../../../protocol/computer-use/v1.golden.frames", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => {
      const [name, hex] = line.split("=");
      return [name!, hex!] as const;
    }),
);
const channelFor = (kind: string) =>
  kind === "mediated_call" || kind === "operation_result"
    ? ("data" as const)
    : ("control" as const);

function byteSample(kind: MessageKind): ComputerUseFrame {
  const value: WireRecord = {};
  for (const [name, [, type]] of Object.entries(messageFields[kind])) {
    value[name] =
      type === "s"
        ? "x"
        : type === "u64"
          ? "1"
          : type === "u32"
            ? 1
            : Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  }
  if (kind === "admit_operation") value.timeout_ms = 10_000;
  if (kind === "operation_result") value.completion = "completed";
  return { kind, value };
}
const byteKinds = (Object.keys(messageFields) as MessageKind[]).filter((kind) =>
  Object.values(messageFields[kind]).some(([, type]) => type === "b"),
);

describe("retained computer-use wire values", () => {
  it.each(["mediated_call", "apply_policy"])(
    "copies byte fields from Buffer-backed golden %s",
    (name) => {
      const input = Buffer.from(golden.get(name)!, "hex");
      const decoded = decodeComputerUseFrame(input, channelFor(name));
      expect(encodeComputerUseFrame(decoded, channelFor(name))).toEqual(new Uint8Array(input));
      const bytes = Object.entries(decoded.value).filter(
        ([, value]) => value instanceof Uint8Array,
      );
      const expected = bytes.map(
        ([key, value]) => [key, new Uint8Array(value as Uint8Array)] as const,
      );
      expect(bytes.length).toBeGreaterThan(0);
      input.fill(0);
      for (const [key, value] of expected) {
        expect(decoded.value[key]).toEqual(value);
        expect(Buffer.isBuffer(decoded.value[key])).toBe(false);
        expect((decoded.value[key] as Uint8Array).buffer).not.toBe(input.buffer);
      }
    },
  );

  it.each(byteKinds)("isolates every retained byte field in slab-backed %s", (kind) => {
    const expected = byteSample(kind);
    const encoded = encodeComputerUseFrame(expected, channelFor(kind));
    const storage = Buffer.alloc(encoded.length + 16, 0xa5);
    storage.set(encoded, 8);
    const input = storage.subarray(8, 8 + encoded.length);
    const decoded = decodeComputerUseFrame(input, channelFor(kind));
    storage.fill(0);
    expect(decoded).toEqual(expected);
    for (const value of Object.values(decoded.value)) {
      if (value instanceof Uint8Array) {
        expect(Buffer.isBuffer(value)).toBe(false);
        expect(value.buffer).not.toBe(storage.buffer);
      }
    }
  });

  it("preserves the shared BOM identity golden in both encoding and Buffer decoding", () => {
    const expected: ComputerUseFrame = {
      kind: "stop",
      value: { operation_id: "\ufeffx", desktop_scope: "d" },
    };
    const input = Buffer.from(golden.get("stop_bom")!, "hex");
    expect(decodeComputerUseFrame(input, "control")).toEqual(expected);
    expect(encodeComputerUseFrame(expected, "control")).toEqual(new Uint8Array(input));
  });

  it.each(["\ufeff", "\ufeffx", "\ufeffé🙂", "x\ufeffy", "\ufeff\ufeffx"])(
    "round trips Unicode/BOM strings losslessly: %j",
    (operation_id) => {
      const expected: ComputerUseFrame = {
        kind: "stop",
        value: { operation_id, desktop_scope: "\ufeff界" },
      };
      const encoded = encodeComputerUseFrame(expected, "control");
      expect(decodeComputerUseFrame(encoded, "control")).toEqual(expected);
      expect(decodeComputerUseFrame(Buffer.from(encoded), "control")).toEqual(expected);
    },
  );
});
