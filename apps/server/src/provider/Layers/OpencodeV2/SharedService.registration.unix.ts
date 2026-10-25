import { constants, type BigIntStats } from "node:fs";
import { open, lstat } from "node:fs/promises";

function assertPrivate(metadata: BigIntStats) {
  if (
    !metadata.isFile() ||
    metadata.size > 16_384n ||
    (metadata.mode & 0o077n) !== 0n ||
    metadata.uid !== BigInt(process.getuid!())
  )
    throw new Error("Invalid registration file.");
}

function assertUnchanged(before: BigIntStats, after: BigIntStats) {
  assertPrivate(after);
  for (const key of [
    "dev",
    "ino",
    "uid",
    "gid",
    "mode",
    "size",
    "mtimeNs",
    "ctimeNs",
    "nlink",
  ] as const)
    if (before[key] !== after[key]) throw new Error("Registration changed during inspection.");
}

/** Bounded same-handle read with before/after privacy and current no-follow pathname fences. */
export async function readV2UnixRegistration(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivate(before);
    assertUnchanged(before, await lstat(file, { bigint: true }));
    const buffer = Buffer.alloc(16_385);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 16_384) throw new Error("Registration exceeds bound.");
    assertUnchanged(before, await handle.stat({ bigint: true }));
    assertUnchanged(before, await lstat(file, { bigint: true }));
    if (BigInt(offset) !== before.size) throw new Error("Incomplete registration read.");
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
