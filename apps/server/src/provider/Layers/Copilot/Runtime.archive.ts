import { createReadStream } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import Path from "node:path";
import { createGunzip } from "node:zlib";

import type { CopilotRuntimeRelease } from "./Runtime.release.ts";

function text(header: Buffer, offset: number, length: number): string {
  return (
    header
      .subarray(offset, offset + length)
      .toString("utf8")
      .split("\0")[0] ?? ""
  );
}

function octal(header: Buffer, offset: number, length: number): number {
  const value = text(header, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid Copilot archive numeric header.");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error("Copilot archive numeric overflow.");
  return number;
}

/**
 * Extracts only the four audited npm members, streaming the executable. No general tar features:
 * paths, links, devices, extensions, duplicate members, and oversized output are rejected.
 * Call only after verifying the entire compressed archive against the pinned digest.
 */
export async function extractCopilotRuntime(input: {
  readonly archive: string;
  readonly destination: string;
  readonly release: CopilotRuntimeRelease;
}): Promise<void> {
  const allowed = new Set([
    `package/${input.release.binaryName}`,
    "package/package.json",
    "package/LICENSE.md",
    "package/README.md",
  ]);
  const seen = new Set<string>();
  await mkdir(Path.join(input.destination, "package"), { mode: 0o700 });
  const source = createReadStream(input.archive);
  const unpacked = createGunzip();
  source.on("error", (error) => unpacked.destroy(error));
  source.pipe(unpacked);
  let pending = Buffer.alloc(0);
  let file: FileHandle | undefined;
  let remaining = 0;
  let padding = 0;
  let outputBytes = 0;
  let archiveBytes = 0;
  let trailingZeros = 0;
  try {
    for await (const chunk of unpacked) {
      const bytes = Buffer.from(chunk as Uint8Array);
      archiveBytes += bytes.byteLength;
      if (archiveBytes > input.release.unpackedBytes + 16_384) {
        throw new Error("Copilot archive exceeds the unpacked size limit.");
      }
      pending = Buffer.concat([pending, bytes]);
      while (pending.length) {
        if (file) {
          const count = Math.min(remaining, pending.length);
          await file.writeFile(pending.subarray(0, count));
          remaining -= count;
          pending = pending.subarray(count);
          if (remaining) break;
          await file.sync();
          await file.close();
          file = undefined;
        } else if (padding) {
          const count = Math.min(padding, pending.length);
          if (pending.subarray(0, count).some((value) => value !== 0)) {
            throw new Error("Invalid Copilot archive padding.");
          }
          pending = pending.subarray(count);
          padding -= count;
        } else if (trailingZeros) {
          if (pending.some((value) => value !== 0))
            throw new Error("Data after Copilot archive end.");
          trailingZeros += pending.length;
          pending = Buffer.alloc(0);
        } else {
          if (pending.length < 512) break;
          const header = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (header.every((value) => value === 0)) {
            trailingZeros = 512;
            continue;
          }
          const checksum = header.reduce(
            (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
            0,
          );
          const name = text(header, 0, 100);
          const kind = header[156];
          if (
            checksum !== octal(header, 148, 8) ||
            text(header, 257, 5) !== "ustar" ||
            text(header, 345, 155) !== "" ||
            (kind !== 0 && kind !== 48) ||
            !allowed.has(name) ||
            seen.has(name)
          ) {
            throw new Error("Unsafe or unsupported Copilot archive member.");
          }
          remaining = octal(header, 124, 12);
          outputBytes += remaining;
          if (remaining === 0 || outputBytes > input.release.unpackedBytes) {
            throw new Error("Copilot archive member exceeds the unpacked size limit.");
          }
          seen.add(name);
          padding = (512 - (remaining % 512)) % 512;
          file = await open(
            Path.join(input.destination, name),
            "wx",
            name === `package/${input.release.binaryName}` ? 0o755 : 0o644,
          );
        }
      }
    }
    if (
      file ||
      padding ||
      pending.length ||
      trailingZeros < 1024 ||
      seen.size !== allowed.size ||
      outputBytes !== input.release.unpackedBytes
    ) {
      throw new Error("Copilot archive is incomplete or has an unexpected installed size.");
    }
  } finally {
    await file?.close();
    source.destroy();
    unpacked.destroy();
  }
}
