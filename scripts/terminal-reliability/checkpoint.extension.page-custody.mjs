// Capture genuine intrinsics in the reviewed realm. Never ask an incoming view
// for its overridable buffer/length fields, nor invoke its iterator/accessors.
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (prototype, key) => Object.getOwnPropertyDescriptor(prototype, key)?.get;
const bufferOf = getter(typedPrototype, "buffer");
const offsetOf = getter(typedPrototype, "byteOffset");
const bytesOf = getter(typedPrototype, "byteLength");
const lengthOf = getter(typedPrototype, "length");
const typeOf = getter(typedPrototype, Symbol.toStringTag);
const arrayBufferBytes = getter(ArrayBuffer.prototype, "byteLength");
const resizable = getter(ArrayBuffer.prototype, "resizable");
const detached = getter(ArrayBuffer.prototype, "detached");
const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const shadows = [
  "buffer",
  "byteLength",
  "byteOffset",
  "length",
  Symbol.iterator,
  Symbol.toStringTag,
];
export const pageLength = (page) => apply(lengthOf, page, []);

export function validatePage(page, expectedLength) {
  let buffer, byteLength, length, offset, backingBytes;
  try {
    // Brand-check BEFORE any reflective operation: a Proxy around a view (or
    // buffer) fails without invoking its get/prototype/descriptor traps.
    buffer = apply(bufferOf, page, []);
    backingBytes = apply(arrayBufferBytes, buffer, []); // SAB fails this brand.
    byteLength = apply(bytesOf, page, []);
    length = apply(lengthOf, page, []);
    offset = apply(offsetOf, page, []);
  } catch {
    throw new Error("invalid checkpoint page/backing store brand");
  }
  if (
    apply(typeOf, page, []) !== "Uint8Array" ||
    prototypeOf(page) !== Uint8Array.prototype ||
    prototypeOf(buffer) !== ArrayBuffer.prototype ||
    shadows.some((key) => descriptor(page, key) !== undefined) ||
    offset !== 0 ||
    length !== expectedLength ||
    byteLength !== expectedLength ||
    backingBytes !== expectedLength ||
    (resizable && apply(resizable, buffer, [])) ||
    (detached && apply(detached, buffer, []))
  )
    throw new Error("invalid checkpoint page length/type/custody");
}

export function validatePages(pages, size, pageBytes) {
  if (
    !Array.isArray(pages) ||
    prototypeOf(pages) !== Array.prototype ||
    descriptor(pages, Symbol.iterator)
  )
    throw new Error("invalid checkpoint page list");
  const descriptors = Object.getOwnPropertyDescriptors(pages);
  const count = descriptors.length?.value;
  if (
    count !== Math.ceil(size / pageBytes) ||
    Object.keys(descriptors).length !== count + 1 ||
    Object.getOwnPropertySymbols(pages).length
  )
    throw new Error("invalid checkpoint page count/fields");
  const trusted = [];
  for (let index = 0; index < count; index++) {
    if (!Object.hasOwn(descriptors[index] ?? {}, "value")) throw new Error("invalid page accessor");
    const page = descriptors[index].value;
    validatePage(page, Math.min(pageBytes, size - index * pageBytes));
    trusted.push(page);
  }
  // Only small trusted metadata is copied, NOT the encoded payload. Ordinary
  // fixed AB backing cannot concurrently mutate: import is synchronous and
  // contains no awaits, caller callbacks or caller iterators through commit.
  return trusted;
}
