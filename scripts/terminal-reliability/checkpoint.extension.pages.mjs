import { pageLength } from "./checkpoint.extension.page-custody.mjs";
export const PAGE_BYTES = 48 * 1024;
export const MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024;

export class PageWriter {
  constructor(size, allocating = false) {
    this.position = 0;
    this.size = size;
    this.scratch = new DataView(new ArrayBuffer(8));
    this.pages = allocating
      ? Array.from(
          { length: Math.ceil(size / PAGE_BYTES) },
          (_, index) => new Uint8Array(Math.min(PAGE_BYTES, size - index * PAGE_BYTES)),
        )
      : null;
  }
  byte(value) {
    if (this.position >= this.size) throw new Error("checkpoint byte budget exceeded");
    if (this.pages)
      this.pages[Math.floor(this.position / PAGE_BYTES)][this.position % PAGE_BYTES] = value;
    this.position++;
  }
  u32(value) {
    for (let i = 0; i < 4; i++) this.byte(value >>> (i * 8));
  }
  number(value) {
    if (!this.pages) {
      this.position += 8;
      return;
    }
    const scratch = this.scratch;
    scratch.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) this.byte(scratch.getUint8(i));
  }
  string(value) {
    this.u32(value.length);
    if (!this.pages) {
      this.position += value.length * 2;
      return;
    }
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      this.byte(unit);
      this.byte(unit >>> 8);
    }
  }
}

export class PageReader {
  constructor(pages, size) {
    this.pages = pages;
    this.size = size;
    this.position = 0;
    this.scratch = new DataView(new ArrayBuffer(8));
  }
  byte() {
    if (this.position >= this.size) throw new Error("truncated checkpoint page");
    const value = this.pages[Math.floor(this.position / PAGE_BYTES)][this.position % PAGE_BYTES];
    this.position++;
    return value;
  }
  u32() {
    return (this.byte() | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24)) >>> 0;
  }
  at(offset) {
    if (offset < 0 || offset + 4 > this.size) throw new Error("invalid typed offset");
    const page = this.pages[Math.floor(offset / PAGE_BYTES)];
    const index = offset % PAGE_BYTES;
    if (index + 4 <= pageLength(page))
      return (
        (page[index] |
          (page[index + 1] << 8) |
          (page[index + 2] << 16) |
          (page[index + 3] << 24)) >>>
        0
      );
    const position = this.position;
    this.position = offset;
    const result = this.u32();
    this.position = position;
    return result;
  }
  skip(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.position + bytes > this.size)
      throw new Error("invalid typed length/offset");
    this.position += bytes;
  }
  number() {
    const scratch = this.scratch;
    for (let i = 0; i < 8; i++) scratch.setUint8(i, this.byte());
    return scratch.getFloat64(0, true);
  }
  string(maximum, charge = () => {}, borrowed = false) {
    const length = this.u32();
    if (length > maximum || this.position + length * 2 > this.size)
      throw new Error("invalid string length");
    charge(64 + length * 4);
    if (borrowed) {
      const value = new StringSlice(this, this.position, length);
      this.skip(length * 2);
      return value;
    }
    return this.decodeString(this.position, length);
  }
  decodeString(offset, length) {
    const previous = this.position;
    this.position = offset;
    const chunks = [];
    for (let offset = 0; offset < length; offset += 4096) {
      const units = new Uint16Array(Math.min(4096, length - offset));
      for (let i = 0; i < units.length; i++) units[i] = this.byte() | (this.byte() << 8);
      chunks.push(String.fromCharCode(...units));
    }
    const result = chunks.join("");
    this.position = previous === offset ? offset + length * 2 : previous;
    return result;
  }
}

export class StringSlice {
  constructor(reader, offset, length) {
    this.reader = reader;
    this.offset = offset;
    this.length = length;
    this.isCheckpointString = true;
  }
  materialize() {
    return this.reader.decodeString(this.offset, this.length);
  }
}
export const isString = (value) => typeof value === "string" || value instanceof StringSlice;

// A validation-only borrowed view: no cell array is allocated until every
// field/reference has passed validation and import staging is reserved.
export class TypedSlice {
  constructor(reader, type, length, planes) {
    this.reader = reader;
    this.type = type;
    this.length = length;
    this.planes = planes;
  }
  get(index) {
    const channel = this.type === "cells" ? index % 3 : 0;
    const column = this.type === "cells" ? Math.floor(index / 3) : index;
    const plane = this.planes[channel];
    const value = plane.uniform ?? this.reader.at(plane.offset + column * 4);
    return this.type === "i32" ? value | 0 : value;
  }
  *entries() {
    for (let i = 0; i < this.length; i++) yield [i, this.get(i)];
  }
  *[Symbol.iterator]() {
    for (let i = 0; i < this.length; i++) yield this.get(i);
  }
  some(predicate) {
    for (let i = 0; i < this.length; i++) if (predicate(this.get(i), i)) return true;
    return false;
  }
  materialize() {
    const ctor = this.type === "i32" ? Int32Array : this.type === "u16" ? Uint16Array : Uint32Array;
    const result = new ctor(this.length);
    for (let i = 0; i < this.length; i++) result[i] = this.get(i);
    return result;
  }
}
export function isTyped(value, ctor) {
  return (
    value instanceof ctor ||
    (value instanceof TypedSlice &&
      (ctor === Uint32Array
        ? ["u32", "cells"].includes(value.type)
        : ctor === Int32Array
          ? value.type === "i32"
          : value.type === "u16"))
  );
}
