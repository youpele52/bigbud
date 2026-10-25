const decoder = new TextDecoder("utf-8", { fatal: true });

export class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  get done(): boolean {
    return this.offset === this.bytes.length;
  }
  uint(): number {
    const value = this.uint64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("integer exceeds safe range");
    return Number(value);
  }
  uint64(): bigint {
    let value = 0n,
      scale = 1n;
    for (let i = 0; i < 10; i++) {
      if (this.offset >= this.bytes.length) throw new Error("truncated varint");
      const byte = this.bytes[this.offset++]!;
      value += BigInt(byte & 127) * scale;
      if (value > 0xffffffffffffffffn) throw new Error("protobuf uint64 overflow");
      if (!(byte & 128)) return value;
      scale *= 128n;
    }
    throw new Error("invalid varint");
  }
  tag(): [number, number] {
    const tag = this.uint();
    const field = Math.floor(tag / 8),
      kind = tag % 8;
    if (!field || ![0, 1, 2, 5].includes(kind)) throw new Error("invalid protobuf tag");
    return [field, kind];
  }
  data(): Uint8Array {
    const length = this.uint();
    if (length > this.bytes.length - this.offset) throw new Error("truncated protobuf field");
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  string(): string {
    return decoder.decode(this.data());
  }
  double(): number {
    if (this.bytes.length - this.offset < 8) throw new Error("truncated double");
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    ).getFloat64(0, true);
    this.offset += 8;
    return value;
  }
  skip(kind: number): void {
    if (kind === 0) {
      this.uint64();
      return;
    }
    if (kind === 2) {
      this.data();
      return;
    }
    const length = kind === 1 ? 8 : 4;
    if (length > this.bytes.length - this.offset) throw new Error("truncated field");
    this.offset += length;
  }
}
export function fields(
  bytes: Uint8Array,
  visit: (field: number, kind: number, reader: Reader) => void,
): void {
  const reader = new Reader(bytes);
  while (!reader.done) {
    const [field, kind] = reader.tag();
    visit(field, kind, reader);
  }
}
export function requireKind(actual: number, expected: number): void {
  if (actual !== expected) throw new Error("invalid wire type");
}
