import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { RemoteBackendAuthorityError } from "./authority.record.ts";

const MAX_IDENTITY_BYTES = 16 * 1024;
export const AUTHORITY_FILENAME = "remote-authority.json";

function unsafeState(): never {
  throw new RemoteBackendAuthorityError(
    "unsafe-state",
    "Remote backend state must use owned private directories and an unlinked private identity file.",
  );
}

function assertOwnedMode(stat: BigIntStats, mode: bigint) {
  if (!process.getuid || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== mode) {
    unsafeState();
  }
}

/** Called before the backend lock or any other state-root writer starts. */
export async function ensurePrivateRemoteStateRoot(stateDir: string) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(stateDir, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsafeState();
  assertOwnedMode(stat, 0o700n);
  return stat;
}

export async function readPrivateAuthority(stateDir: string): Promise<string | undefined> {
  const path = join(stateDir, AUTHORITY_FILENAME);
  const handle = await fs
    .open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((cause) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw new RemoteBackendAuthorityError(
        "unsafe-state",
        "The private backend identity cannot be opened safely.",
        { cause },
      );
    });
  if (!handle) return undefined;
  try {
    const before = await handle.stat({ bigint: true });
    if (before.nlink !== 1n) {
      throw new RemoteBackendAuthorityError(
        "unsafe-state",
        "The remote identity has an unexpected link count. Preserve the identity and linked files, then repair the installation explicitly.",
      );
    }
    if (!before.isFile() || before.size > BigInt(MAX_IDENTITY_BYTES)) unsafeState();
    assertOwnedMode(before, 0o600n);
    const bytes = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat({ bigint: true });
    if (
      bytesRead > MAX_IDENTITY_BYTES ||
      BigInt(bytesRead) !== after.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ino !== after.ino ||
      after.nlink !== 1n
    )
      unsafeState();
    assertOwnedMode(after, 0o600n);
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Publish complete durable bytes without replacing an existing identity.
 * A crash between link/unlink preserves two private links and fails closed on restart;
 * identity is never returned or served until unlink and the directory sync finish.
 * Repair must preserve that key rather than silently prune unproven links or regenerate it.
 */
export async function publishPrivateAuthority(
  stateDir: string,
  contents: string,
  assertHeld: () => Promise<void>,
) {
  const temporary = join(stateDir, `.remote-authority-${randomBytes(16).toString("hex")}.tmp`);
  const finalPath = join(stateDir, AUTHORITY_FILENAME);
  let temporaryExists = false;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertHeld();
    await fs.link(temporary, finalPath);
    await fs.unlink(temporary);
    temporaryExists = false;
    const directory = await fs.open(
      stateDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (temporaryExists) await fs.unlink(temporary);
  }
}
