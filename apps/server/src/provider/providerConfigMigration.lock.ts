import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OWNER_FILE = "owner.json";
/** A migration rewrites a few small files; a lock held this long belongs to a dead or hung server. */
export const PROVIDER_MIGRATION_LOCK_STALE_MS = 60_000;
const DEFAULT_WAIT_MS = 5_000;
const RETRY_DELAY_MS = 50;

type LockOwner = { readonly token: string; readonly pid: number };

/** Releases the lock only while this acquisition still owns it. */
export type ProviderMigrationLockRelease = () => Promise<void>;

function lockUnavailable(lock: string, cause: unknown) {
  return new Error(
    `Provider migration lock unavailable: ${lock}. Check for another server or a stale lock before retrying.`,
    { cause },
  );
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(lock, OWNER_FILE), "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as LockOwner).token === "string" &&
      Number.isInteger((value as LockOwner).pid)
    ) {
      return value as LockOwner;
    }
  } catch {
    // Missing or partial owner file: judged by age below.
  }
  return undefined;
}

/**
 * `undefined` when the lock vanished. A lock is stale when its owner process is gone, or when it is
 * older than the stale window (also covers ownerless locks from a crash or an older bigbud).
 */
async function isStaleLock(lock: string, staleMs: number): Promise<boolean | undefined> {
  const info = await stat(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  const owner = await readOwner(lock);
  if (owner && !processIsAlive(owner.pid)) return true;
  return Date.now() - info.mtimeMs > staleMs;
}

/** Moves the stale lock aside first, so a concurrent recoverer cannot delete a fresh lock. */
async function discardStaleLock(lock: string) {
  const tombstone = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(tombstone, { recursive: true, force: true });
}

/**
 * Cross-process lock for one provider configuration. Returns `undefined` when the configuration's
 * directory does not exist (nothing to migrate). Waits briefly for a live holder in another server,
 * recovers stale locks, and fails with the documented message only when a live holder persists.
 */
export async function acquireProviderMigrationLock(
  lock: string,
  options: { readonly waitMs?: number; readonly staleMs?: number } = {},
): Promise<ProviderMigrationLockRelease | undefined> {
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const staleMs = options.staleMs ?? PROVIDER_MIGRATION_LOCK_STALE_MS;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (code !== "EEXIST") throw lockUnavailable(lock, error);
      const stale = await isStaleLock(lock, staleMs);
      if (stale === true) {
        await discardStaleLock(lock);
        continue;
      }
      if (stale === undefined) continue;
      if (Date.now() >= deadline) throw lockUnavailable(lock, error);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  const token = randomUUID();
  try {
    await writeFile(join(lock, OWNER_FILE), JSON.stringify({ token, pid: process.pid }), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    await rm(lock, { recursive: true, force: true });
    throw lockUnavailable(lock, error);
  }
  return async () => {
    if ((await readOwner(lock))?.token === token) {
      await rm(lock, { recursive: true, force: true });
    }
  };
}
