/**
 * Backend instance lock: one bigbud backend per state directory (one `state.sqlite`).
 *
 * The lock file `<stateDir>/backend.lock` is created exclusively with complete content (temp file
 * + hard link, the content-carrying equivalent of `O_EXCL`), so readers never observe a partial
 * record. A live owner refuses startup. A provably dead owner (ESRCH, or a different process start
 * time for the same PID) is removed under an exclusive takeover mutex and replaced by a fresh
 * exclusive create. Unprovable owners (unreadable record, other host, unobtainable start time)
 * fail closed.
 *
 * @module stateDirLock
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Ownership from "@bigbud/shared/backendOwnership.record";

import { Data } from "effect";

import { machineIdentity } from "../utils/machineIdentity.ts";
import { compareProcessStartToken, processStartToken } from "../utils/processStartToken.ts";

export const STATE_DIR_LOCK_FILENAME = "backend.lock";
const FORMAT = "bigbud.backend-lock.v1";

export type StateDirLockRecord = Ownership.StateDirLockRecord;

export class StateDirLockError extends Data.TaggedError("StateDirLockError")<{
  readonly message: string;
  readonly stateDir: string;
  readonly reason?: "state_directory_in_use" | "state_directory_owner_unverified";
  readonly cause?: unknown;
}> {}

export interface StateDirLockProbe {
  readonly pid: number;
  readonly hostname: () => string;
  /** This machine's stable identity; absent or null keeps the hostname rule. */
  readonly machineId?: () => string | null;
  readonly isAlive: (pid: number) => boolean;
  readonly startToken: (pid: number) => string | undefined;
}

export const defaultStateDirLockProbe: StateDirLockProbe = {
  pid: process.pid,
  hostname: () => os.hostname(),
  machineId: machineIdentity,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      // EPERM: the process exists but belongs to another user.
      return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
    }
  },
  startToken: processStartToken,
};

const errorCode = (cause: unknown) =>
  cause instanceof Error && "code" in cause ? String(cause.code) : undefined;

export function parseStateDirLockRecord(raw: string): StateDirLockRecord | undefined {
  return Ownership.parseStateDirLockRecord(raw);
}

/** Same machine by stable machine id when both sides carry one; otherwise by hostname (older
 * records, platforms without an id), which a network rename can defeat: then it fails closed. */
export function isSameStateDirLockHost(
  owner: Pick<StateDirLockRecord, "hostname" | "machineId">,
  probe: StateDirLockProbe,
): boolean {
  const local = probe.machineId?.() ?? null;
  return owner.machineId && local ? owner.machineId === local : owner.hostname === probe.hostname();
}

/** "dead" only with proof; anything unprovable is a live owner. Another host's record cannot be
 * checked from here at all ("foreign-host"), so it is refused like a live owner. */
export function classifyStateDirLockOwner(
  owner: StateDirLockRecord,
  probe: StateDirLockProbe,
): "live" | "dead" | "foreign-host" {
  if (!isSameStateDirLockHost(owner, probe)) return "foreign-host";
  if (!probe.isAlive(owner.pid)) return "dead";
  // Only two comparable tokens that differ prove the PID was reused by an unrelated process.
  return compareProcessStartToken(owner.startedAt, probe.startToken(owner.pid)) === "different"
    ? "dead"
    : "live";
}

/** Exclusive create with complete content; falls back to `wx` where hard links are unsupported. */
async function createExclusive(lockPath: string, content: string, nonce: string) {
  const temp = `${lockPath}.${nonce}.tmp`;
  await fs.writeFile(temp, content, { mode: 0o600, flag: "wx" });
  try {
    await fs.link(temp, lockPath);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "ENOSYS", "EOPNOTSUPP"].includes(errorCode(cause) ?? "")) throw cause;
    try {
      await fs.writeFile(lockPath, content, { mode: 0o600, flag: "wx" });
      return true;
    } catch (fallback) {
      if (errorCode(fallback) === "EEXIST") return false;
      throw fallback;
    }
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

/**
 * Remove a proven-dead owner's record under an exclusive takeover mutex. Only a takeover holder
 * may remove another owner's lock, and a dead owner cannot release, so the record cannot change
 * between the holder's re-read and unlink. An orphaned takeover (its holder provably dead) is
 * cleared only if unchanged; a live or unreadable takeover is waited on by the caller's retry.
 */
async function displaceStale(
  lockPath: string,
  observed: string,
  content: string,
  nonce: string,
  probe: StateDirLockProbe,
) {
  const takeover = `${lockPath}.takeover`;
  if (!(await createExclusive(takeover, content, `${nonce}.takeover`))) {
    const raw = await fs.readFile(takeover, "utf8").catch((cause: unknown) => {
      if (errorCode(cause) === "ENOENT") return undefined;
      throw cause;
    });
    const holder = raw === undefined ? undefined : parseStateDirLockRecord(raw);
    if (holder && classifyStateDirLockOwner(holder, probe) === "dead")
      await unlinkIfUnchanged(takeover, raw!);
    return;
  }
  try {
    if ((await readIfPresent(lockPath)) === observed) await unlinkIfUnchanged(lockPath, observed);
  } finally {
    await releaseStateDirLock(takeover, JSON.parse(content).nonce);
  }
}

async function readIfPresent(filename: string) {
  try {
    return await fs.readFile(filename, "utf8");
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  }
}

/** Atomically capture the file under a private name, then delete it only if it is still the
 * expected record; a successor captured by a lost race is restored with an exclusive link. */
async function unlinkIfUnchanged(filename: string, expected: string) {
  if ((await readIfPresent(filename)) !== expected) return;
  const captured = `${filename}.${randomBytes(8).toString("hex")}.stale`;
  try {
    await fs.rename(filename, captured);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return;
    throw cause;
  }
  try {
    if ((await readIfPresent(captured)) !== expected)
      await fs.link(captured, filename).catch((cause: unknown) => {
        if (errorCode(cause) !== "EEXIST") throw cause;
      });
  } finally {
    await fs.unlink(captured).catch(() => {});
  }
}

export interface StateDirLockHandle {
  readonly lockPath: string;
  readonly record: StateDirLockRecord;
  /** Removes the lock only while it still carries this owner's nonce. Idempotent. */
  readonly release: () => Promise<void>;
}

export async function acquireStateDirLock(input: {
  readonly stateDir: string;
  readonly port: number;
  readonly probe?: StateDirLockProbe;
  readonly now?: () => Date;
  readonly control?: Ownership.OwnershipControl;
}): Promise<StateDirLockHandle> {
  const probe = input.probe ?? defaultStateDirLockProbe;
  const lockPath = path.join(input.stateDir, STATE_DIR_LOCK_FILENAME);
  await fs.mkdir(input.stateDir, { recursive: true });
  const nonce = randomBytes(16).toString("hex");
  const machineId = probe.machineId?.() ?? null;
  const record: StateDirLockRecord = {
    format: FORMAT,
    pid: probe.pid,
    startedAt: probe.startToken(probe.pid) ?? null,
    port: input.port,
    hostname: probe.hostname(),
    ...(machineId ? { machineId } : {}),
    acquiredAt: (input.now?.() ?? new Date()).toISOString(),
    nonce,
    ...(input.control ? { control: input.control } : {}),
  };
  const content = `${JSON.stringify(record)}\n`;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await createExclusive(lockPath, content, `${nonce}.${attempt}`))
      return { lockPath, record, release: () => releaseStateDirLock(lockPath, nonce) };
    let raw: string;
    try {
      raw = await fs.readFile(lockPath, "utf8");
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") continue; // Released between create and read.
      throw cause;
    }
    const owner = parseStateDirLockRecord(raw);
    if (!owner)
      throw new StateDirLockError({
        stateDir: input.stateDir,
        message: `The bigbud backend lock ${lockPath} is unreadable. If no bigbud backend is running, delete it; otherwise use a different BIGBUD_HOME.`,
        reason: "state_directory_owner_unverified",
      });
    const state = classifyStateDirLockOwner(owner, probe);
    if (state === "foreign-host")
      throw new StateDirLockError({
        stateDir: input.stateDir,
        message: `The bigbud backend lock ${lockPath} was written on host "${owner.hostname}" (pid ${owner.pid}, port ${owner.port}), not this host "${probe.hostname()}", so its owner cannot be checked. If this is the same machine, confirm no bigbud backend is running and remove ${lockPath} (hostnames can change with the network); otherwise use a different BIGBUD_HOME.`,
        reason: "state_directory_owner_unverified",
      });
    if (state === "live")
      throw new StateDirLockError({
        stateDir: input.stateDir,
        message: `Another bigbud backend (pid ${owner.pid}, port ${owner.port}) owns ${input.stateDir}; stop it or use a different BIGBUD_HOME.`,
        reason: "state_directory_in_use",
      });
    await displaceStale(lockPath, raw, content, `${nonce}.${attempt}`, probe);
    await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
  }
  throw new StateDirLockError({
    stateDir: input.stateDir,
    message: `Could not acquire the bigbud backend lock ${lockPath} under contention; retry or use a different BIGBUD_HOME.`,
  });
}

export async function releaseStateDirLock(lockPath: string, nonce: string) {
  const raw = await readIfPresent(lockPath);
  if (raw === undefined || parseStateDirLockRecord(raw)?.nonce !== nonce) return; // Successor kept.
  await unlinkIfUnchanged(lockPath, raw);
}
