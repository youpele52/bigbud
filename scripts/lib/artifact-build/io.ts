import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import type { Stats } from "node:fs";
import { resolve } from "node:path";

export const MAX_COMPONENT_BYTES = 128 * 1024 * 1024;

export function fingerprint(info: Stats): string {
  return [
    info.dev,
    info.ino,
    info.size,
    info.mode,
    info.uid,
    info.gid,
    info.nlink,
    info.mtimeMs,
    info.ctimeMs,
  ].join(":");
}

export async function canonicalInput(path: string): Promise<string> {
  const absolute = resolve(path);
  if ((await lstat(absolute)).isSymbolicLink()) throw new Error("Input links are forbidden.");
  return realpath(absolute);
}

/** O_NONBLOCK prevents a raced FIFO replacement from hanging before fstat. */
export async function readStableFile(
  path: string,
  maximum = MAX_COMPONENT_BYTES,
): Promise<{
  bytes: Buffer;
  sha256: string;
  identity: string;
  info: Stats;
}> {
  if ((await realpath(path)) !== path) throw new Error("Input ancestor links are forbidden.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum || before.size < 0) {
      throw new Error("Input must be a bounded regular file without hard links.");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("Input shortened while reading.");
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if (
      (await file.read(extra, 0, 1, offset)).bytesRead ||
      fingerprint(await file.stat()) !== fingerprint(before) ||
      fingerprint(await lstat(path)) !== fingerprint(before) ||
      (await realpath(path)) !== path
    ) {
      throw new Error("Input changed while reading.");
    }
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: fingerprint(before),
      info: before,
    };
  } finally {
    await file.close();
  }
}

export async function readSigningKey(path: string): Promise<KeyObject> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (info.mode & 0o077) !== 0 ||
    process.getuid === undefined ||
    info.uid !== process.getuid()
  ) {
    throw new Error("Signing key must be an owned, owner-only regular file without links.");
  }
  const read = await readStableFile(path, 16 * 1024);
  try {
    if (read.identity !== fingerprint(info)) throw new Error("Signing key changed.");
    const key = createPrivateKey(read.bytes);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519.");
    return key;
  } finally {
    read.bytes.fill(0);
  }
}
