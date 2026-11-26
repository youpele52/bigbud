import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  WireReader,
  WireWriter,
} from "../../apps/server/src/remote-agent/remoteAgentProtocol.codec.wire.ts";

type Field = readonly [tag: number, value: number | boolean | string | Uint8Array | Message];
export type Message = readonly Field[];

const reader = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const clientFrameMax = 64 * 1024;
export const ownerFrameMax = 8 * 1024 * 1024;
export const bytes = (hex: string) => Buffer.from(hex, "hex");

export function encode(fields: Message): Uint8Array {
  const writer = new WireWriter();
  for (const [tag, value] of fields) {
    if (typeof value === "number" && value !== 0) writer.fieldUint(tag, value);
    else if (typeof value === "boolean" || value === 0) {
      // The explicit-presence scalar fixtures all have a one-byte varint tag.
      assert.ok(tag > 0 && tag < 16);
      writer.bytes.push(tag * 8, Number(value));
    } else if (typeof value === "string") writer.fieldRepeatedString(tag, value);
    else if (value instanceof Uint8Array) writer.fieldBytes(tag, value);
    else writer.fieldRepeatedMessage(tag, encode(value));
  }
  return writer.finish();
}

/** Hash the selected operation, not its request envelope. */
export function operandPreimage(tag: number, operand: Message): Buffer {
  return Buffer.concat([Buffer.from("bigbud.ssh_owner.v1/operands\0"), encode([[tag, operand]])]);
}

export function assertDecoded(payload: Uint8Array, fields: Message) {
  const wire = new WireReader(payload);
  for (const [field, expected] of fields) {
    const isVarint = typeof expected === "number" || typeof expected === "boolean";
    assert.deepEqual(wire.tag(), { field, wireType: isVarint ? 0 : 2 });
    if (isVarint) assert.equal(wire.uint(), Number(expected));
    else if (typeof expected === "string") assert.equal(reader.decode(wire.bytesValue()), expected);
    else if (expected instanceof Uint8Array)
      assert.deepEqual(Buffer.from(wire.bytesValue()), Buffer.from(expected));
    else assertDecoded(wire.bytesValue(), expected);
  }
  assert.equal(wire.done, true, "unexpected fields");
}

export function frame(payload: Uint8Array): Buffer {
  const result = Buffer.alloc(4 + payload.length);
  result.writeUInt32BE(payload.length);
  result.set(payload, 4);
  return result;
}

export function frameLength(prefix: Buffer, maximum: number): number {
  if (prefix.length !== 4) throw new Error("prefix");
  const length = prefix.readUInt32BE();
  if (length === 0) throw new Error("empty");
  if (length > maximum) throw new Error("oversized");
  return length;
}

export function framePayload(encoded: Buffer, maximum = clientFrameMax): Buffer {
  const length = frameLength(encoded.subarray(0, 4), maximum);
  if (length !== encoded.length - 4) throw new Error("length");
  return encoded.subarray(4);
}

export function goldens(file: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of readFileSync(new URL(file, import.meta.url), "utf8")
    .trimEnd()
    .split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-z0-9_.-]+)=((?:[a-f0-9]{2})+)$/.exec(line);
    assert.ok(match, line);
    const [, name, hex] = match;
    assert.ok(name && hex && !values.has(name), line);
    values.set(name, hex);
  }
  return values;
}

export function consume(values: Map<string, string>, name: string): Buffer {
  const value = values.get(name);
  assert.ok(value, name);
  values.delete(name);
  return bytes(value);
}

export function pickerPreimage(path?: string): Buffer {
  return operandPreimage(14, path === "" || path === undefined ? [] : [[1, path]]);
}
