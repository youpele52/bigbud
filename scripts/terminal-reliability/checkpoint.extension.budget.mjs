export const STATE_BYTES = 128 * 1024 * 1024;
export const PROFILE_BYTES = 512 * 1024 * 1024;
let reserved = 0;

export function reserve(bytes, limit = STATE_BYTES) {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > limit ||
    reserved + bytes > PROFILE_BYTES
  )
    throw new Error("checkpoint staging/profile budget exceeded");
  reserved += bytes;
  let live = true;
  return {
    get bytes() {
      return bytes;
    },
    shrink(next) {
      if (!live || next < 0 || next > bytes) throw new Error("invalid reservation shrink");
      reserved -= bytes - next;
      bytes = next;
    },
    release() {
      if (live) {
        live = false;
        reserved -= bytes;
      }
    },
  };
}
export function reservedBytes() {
  return reserved;
}

// Conservative accounting estimate; V8 RSS/heap high-water measurements remain
// mandatory and distinct. Count live backing buffers, strings and object/maps,
// not only the compressed checkpoint. TypedSlice charges its future allocation.
export function accountState(value, seen = new Set()) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return 64 + value.length * 4;
  if (typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value.isCheckpointString) return 256 + value.length * 4;
  if (ArrayBuffer.isView(value)) return 128 + value.buffer.byteLength;
  if (value.type && value.planes && value.reader)
    return 256 + value.length * (value.type === "u16" ? 2 : 4);
  let bytes = Array.isArray(value) ? 128 + value.length * 16 : 256;
  for (const key of Object.keys(value)) bytes += 32 + accountState(value[key], seen);
  return bytes;
}
