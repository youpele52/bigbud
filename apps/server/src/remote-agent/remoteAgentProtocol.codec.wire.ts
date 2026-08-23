import { RemoteAgentProtocolDecodeError } from "./remoteAgentProtocol.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class WireWriter {
  readonly bytes: number[] = [];

  fieldBytes(field: number, value: Uint8Array): void {
    if (value.length === 0) return;
    this.tag(field, 2);
    this.varint(value.length);
    this.bytes.push(...value);
  }

  fieldString(field: number, value: string): void {
    this.fieldBytes(field, textEncoder.encode(value));
  }

  fieldMessage(field: number, value: Uint8Array): void {
    this.fieldBytes(field, value);
  }

  fieldBool(field: number, value: boolean): void {
    if (!value) return;
    this.tag(field, 0);
    this.varint(1);
  }

  fieldUint(field: number, value: number): void {
    if (value === 0) return;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`protobuf uint must be a non-negative safe integer: ${value}`);
    }
    this.tag(field, 0);
    this.varint(value);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  private tag(field: number, wireType: number): void {
    this.varint(field * 8 + wireType);
  }

  private varint(value: number): void {
    let remaining = value;
    while (remaining >= 128) {
      this.bytes.push((remaining % 128) | 128);
      remaining = Math.floor(remaining / 128);
    }
    this.bytes.push(remaining);
  }
}

export class WireReader {
  private offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  tag(): { readonly field: number; readonly wireType: number } {
    const value = this.uint();
    const field = Math.floor(value / 8);
    const wireType = value % 8;
    if (field <= 0) throw new RemoteAgentProtocolDecodeError("protobuf field number is invalid");
    return { field, wireType };
  }

  bytesValue(): Uint8Array {
    const length = this.uint();
    if (length > this.bytes.length - this.offset) {
      throw new RemoteAgentProtocolDecodeError("protobuf length-delimited field exceeds frame");
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string(): string {
    try {
      return textDecoder.decode(this.bytesValue());
    } catch {
      throw new RemoteAgentProtocolDecodeError("protobuf string is not valid UTF-8");
    }
  }

  uint(): number {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.length) {
        throw new RemoteAgentProtocolDecodeError("protobuf varint is truncated");
      }
      const byte = this.bytes[this.offset++]!;
      value += (byte & 0x7f) * multiplier;
      if (value > Number.MAX_SAFE_INTEGER) {
        throw new RemoteAgentProtocolDecodeError("protobuf integer exceeds safe range");
      }
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new RemoteAgentProtocolDecodeError("protobuf varint is too long");
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.uint();
      return;
    }
    const byteLength = wireType === 1 ? 8 : wireType === 5 ? 4 : undefined;
    if (byteLength !== undefined) {
      if (byteLength > this.bytes.length - this.offset) {
        throw new RemoteAgentProtocolDecodeError("protobuf fixed field exceeds frame");
      }
      this.offset += byteLength;
      return;
    }
    if (wireType === 2) {
      this.bytesValue();
      return;
    }
    throw new RemoteAgentProtocolDecodeError(`unsupported protobuf wire type ${wireType}`);
  }
}

export function decodeMessage(
  bytes: Uint8Array,
  visit: (field: number, wireType: number, reader: WireReader) => void,
): void {
  const reader = new WireReader(bytes);
  while (!reader.done) {
    const { field, wireType } = reader.tag();
    visit(field, wireType, reader);
  }
}

export function requireWireType(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new RemoteAgentProtocolDecodeError(
      `protobuf field has wire type ${actual}, expected ${expected}`,
    );
  }
}
