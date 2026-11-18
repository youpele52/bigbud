import { createInflateRaw, crc32 } from "node:zlib";
import { MOBILE_ASSET_MAX_EXPANDED_BYTES } from "@bigbud/shared/mobileOptionalAssets.policy";
import type { MobileAssetTarParser } from "./mobileOptionalAssets.tar.ts";

/** Single-member gzip, deliberately excluding optional fields not emitted by our producer. */
export async function extractMobileAssetGzip(
  bytes: Buffer,
  parser: MobileAssetTarParser,
  signal?: AbortSignal,
): Promise<void> {
  if (
    bytes.length < 18 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b ||
    bytes[2] !== 8 ||
    bytes[3] !== 0
  ) {
    throw new Error("Unsupported mobile assets gzip header.");
  }
  const inflate = createInflateRaw({ chunkSize: 64 * 1024 });
  const abort = () => inflate.destroy(new Error("Mobile assets extraction cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  let checksum = 0;
  let expanded = 0;
  try {
    signal?.throwIfAborted();
    // Input is already a bounded private byte snapshot. Raw inflate exposes exact deflate extent.
    inflate.end(bytes.subarray(10));
    for await (const value of inflate) {
      signal?.throwIfAborted();
      const chunk = value as Buffer;
      expanded += chunk.length;
      if (expanded > MOBILE_ASSET_MAX_EXPANDED_BYTES)
        throw new Error("Mobile assets expansion budget exceeded.");
      checksum = crc32(chunk, checksum);
      await parser.consume(chunk);
    }
    const trailer = 10 + inflate.bytesWritten;
    if (
      trailer + 8 !== bytes.length ||
      bytes.readUInt32LE(trailer) !== checksum ||
      bytes.readUInt32LE(trailer + 4) !== expanded
    ) {
      throw new Error("Concatenated, trailing or corrupt mobile assets gzip payload.");
    }
    parser.finish();
  } finally {
    signal?.removeEventListener("abort", abort);
    inflate.destroy();
    await parser.close();
  }
}
