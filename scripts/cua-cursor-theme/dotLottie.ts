import { crc32 } from "node:zlib";

import type { JsonObject } from "./lottie.ts";

/** MS-DOS timestamp for 1980-01-01 00:00, so rebuilds are byte-identical. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;
/**
 * Entries are stored uncompressed: deflate output differs between zlib builds
 * (Bun and Node disagree), which would make the checked-in source unreproducible.
 */
const METHOD_STORED = 0;
const REGULAR_FILE_0644 = (0o100644 << 16) >>> 0;

interface ZipEntry {
  readonly name: Buffer;
  readonly data: Buffer;
  readonly crc: number;
  readonly offset: number;
}

function localHeader(entry: ZipEntry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(METHOD_STORED, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, entry.name]);
}

function centralHeader(entry: ZipEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(METHOD_STORED, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(entry.name.length, 28);
  // Extra field, comment, disk number and internal attributes stay zero.
  header.writeUInt32LE(REGULAR_FILE_0644, 38);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  return record;
}

/** A deterministic ZIP of the given files, in the given order. */
export function zipArchive(files: ReadonlyArray<readonly [name: string, data: Buffer]>): Buffer {
  const entries: ZipEntry[] = [];
  const localParts: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const entry: ZipEntry = { name: Buffer.from(name, "utf8"), data, crc: crc32(data), offset };
    const local = Buffer.concat([localHeader(entry), data]);
    localParts.push(local);
    entries.push(entry);
    offset += local.length;
  }
  const central = Buffer.concat(entries.map(centralHeader));
  return Buffer.concat([
    ...localParts,
    central,
    endOfCentralDirectory(entries.length, central.length, offset),
  ]);
}

function encodedJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

/** The dotLottie source layout `cua-cursor-theme` compiles. */
export function dotLottieArchive(input: {
  readonly generator: string;
  readonly semanticManifest: JsonObject;
  readonly animations: ReadonlyMap<string, JsonObject>;
}): Buffer {
  const ids = [...input.animations.keys()];
  return zipArchive([
    [
      "manifest.json",
      encodedJson({
        version: "2",
        generator: input.generator,
        animations: ids.map((id) => ({ id, name: id })),
      }),
    ],
    ["cua/theme.json", encodedJson(input.semanticManifest)],
    ...ids.map((id) => [`a/${id}.json`, encodedJson(input.animations.get(id))] as const),
  ]);
}
