import type { Field, WireValue } from "./protocol.fields";

export class ComputerUseProtocolError extends Error {
  constructor(readonly code: "length" | "invalid" | "channel" | "incompatible") {
    super(`Computer-use protocol ${code}.`);
  }
}
export function requireProtocol(
  value: unknown,
  code: ComputerUseProtocolError["code"] = "invalid",
): asserts value {
  if (!value) throw new ComputerUseProtocolError(code);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_U64 = (1n << 64n) - 1n;

export function varint(value: bigint): Uint8Array {
  requireProtocol(value >= 0n && value <= MAX_U64);
  const bytes: number[] = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    bytes.push(value === 0n ? byte : byte | 128);
  } while (value !== 0n);
  return Uint8Array.from(bytes);
}

export class WireReader {
  private offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  get done(): boolean {
    return this.offset === this.bytes.length;
  }
  uint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      const byte = this.bytes[this.offset++];
      requireProtocol(byte !== undefined);
      value |= BigInt(byte & 127) << shift;
      if ((byte & 128) === 0) {
        requireProtocol(value <= MAX_U64);
        return value;
      }
    }
    throw new ComputerUseProtocolError("invalid");
  }
  tag(): readonly [number, number] {
    const value = this.uint();
    requireProtocol(value <= 0xffff_ffffn && value >= 8n);
    return [Number(value >> 3n), Number(value & 7n)];
  }
  take(): Uint8Array {
    const size = this.uint();
    requireProtocol(size <= BigInt(this.bytes.length - this.offset));
    const end = this.offset + Number(size);
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }
  skip(wire: number): void {
    if (wire === 0) this.uint();
    else if (wire === 2) this.take();
    else throw new ComputerUseProtocolError("invalid");
  }
}

export function encodeField([id, kind, limit]: Field, value: WireValue): Uint8Array[] {
  if (kind === "u32" || kind === "u64") {
    if (kind === "u32")
      requireProtocol(
        typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff,
      );
    else requireProtocol(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value));
    const number = BigInt(value as string | number);
    requireProtocol(number <= MAX_U64);
    return number === 0n ? [] : [varint(BigInt(id * 8)), varint(number)];
  }
  let bytes: Uint8Array;
  if (kind === "s") {
    requireProtocol(typeof value === "string" && !value.includes("\0") && value.length <= limit);
    bytes = encoder.encode(value);
    requireProtocol(decoder.decode(bytes) === value);
  } else {
    requireProtocol(value instanceof Uint8Array && !(value.buffer instanceof SharedArrayBuffer));
    bytes = value;
  }
  requireProtocol(bytes.length <= limit);
  return bytes.length === 0
    ? []
    : [varint(BigInt(id * 8 + 2)), varint(BigInt(bytes.length)), bytes];
}

export function decodeField(reader: WireReader, wire: number, [, kind, limit]: Field): WireValue {
  requireProtocol(wire === (kind === "s" || kind === "b" ? 2 : 0));
  if (kind === "u64") return reader.uint().toString();
  if (kind === "u32") {
    const value = reader.uint();
    requireProtocol(value <= 0xffff_ffffn);
    return Number(value);
  }
  const value = reader.take();
  requireProtocol(value.length <= limit);
  if (kind === "b") return new Uint8Array(value);
  try {
    const text = decoder.decode(value);
    requireProtocol(!text.includes("\0"));
    return text;
  } catch {
    throw new ComputerUseProtocolError("invalid");
  }
}

export function join(chunks: readonly Uint8Array[], maximum: number): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  requireProtocol(size <= maximum, "length");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
