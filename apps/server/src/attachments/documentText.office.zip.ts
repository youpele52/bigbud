import { setImmediate } from "node:timers/promises";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

export const MAX_OFFICE_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_OFFICE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_OFFICE_ENTRIES = 4096;
const END_HEADER_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;

export class OfficeDocumentLimitError extends Error {
  constructor() {
    super(
      "This Office document exceeds the text extraction limit. Try a smaller document or export the relevant pages as text.",
    );
  }
}

async function inflateEntry(data: Buffer, declaredSize: number, signal?: AbortSignal) {
  // Native zlib inflates asynchronously; the consumer enforces the actual size, not only ZIP metadata.
  return pipeline(
    [data],
    createInflateRaw(),
    async (source) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > declaredSize) throw new OfficeDocumentLimitError();
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    },
    signal ? { signal } : {},
  );
}

/** Reads only the text-bearing ZIP parts requested by the format-specific extractor. */
export async function extractOfficeZipEntries(
  input: Uint8Array,
  include: (name: string) => boolean,
  signal?: AbortSignal,
): Promise<Map<string, Buffer>> {
  signal?.throwIfAborted();
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const searchStart = Math.max(0, bytes.length - (0xffff + END_HEADER_BYTES));
  let end = bytes.length - END_HEADER_BYTES;
  while (
    end >= searchStart &&
    (bytes.readUInt32LE(end) !== 0x06054b50 ||
      end + END_HEADER_BYTES + bytes.readUInt16LE(end + 20) !== bytes.length)
  )
    end--;
  const entries = new Map<string, Buffer>();
  if (end < searchStart) return entries;

  const count = bytes.readUInt16LE(end + 10);
  if (count > MAX_OFFICE_ENTRIES) throw new OfficeDocumentLimitError();
  let offset = bytes.readUInt32LE(end + 16);
  const centralStart = offset;
  const centralEnd = centralStart + bytes.readUInt32LE(end + 12);
  if (centralEnd > end) return new Map();
  let remaining = MAX_OFFICE_TOTAL_BYTES;
  for (let index = 0; index < count; index++) {
    if (index % 64 === 0) await setImmediate(undefined, { signal });
    if (offset + CENTRAL_HEADER_BYTES > centralEnd || bytes.readUInt32LE(offset) !== 0x02014b50)
      return new Map();
    const method = bytes.readUInt16LE(offset + 10);
    const storedSize = bytes.readUInt32LE(offset + 20);
    const declaredSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + CENTRAL_HEADER_BYTES;
    offset = nameStart + nameLength + extraLength + commentLength;
    if (offset > centralEnd) return new Map();
    if (nameLength > 256) continue;
    const name = bytes.toString("utf8", nameStart, nameStart + nameLength);
    if (!include(name) || entries.has(name) || (method !== 0 && method !== 8)) continue;
    if (declaredSize > Math.min(MAX_OFFICE_ENTRY_BYTES, remaining))
      throw new OfficeDocumentLimitError();
    if (local + LOCAL_HEADER_BYTES > centralStart || bytes.readUInt32LE(local) !== 0x04034b50)
      return new Map();
    const dataStart =
      local + LOCAL_HEADER_BYTES + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (dataStart + storedSize > centralStart) return new Map();
    const data = bytes.subarray(dataStart, dataStart + storedSize);
    const expanded = method === 0 ? data : await inflateEntry(data, declaredSize, signal);
    if (expanded.byteLength !== declaredSize) return new Map();
    remaining -= expanded.byteLength;
    entries.set(name, expanded);
  }
  signal?.throwIfAborted();
  return entries;
}
