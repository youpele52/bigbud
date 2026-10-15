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

import { Data, Effect, Layer } from "effect";

import { processStartToken } from "../utils/processStartToken.ts";
import { ServerConfig } from "./config.ts";

export const STATE_DIR_LOCK_FILENAME = "backend.lock";
const FORMAT = "bigbud.backend-lock.v1";

export interface StateDirLockRecord {
  readonly format: typeof FORMAT;
  readonly pid: number;
  /** Process start token (`ps lstart`), or null when unobtainable on this platform. */
  readonly startedAt: string | null;
  readonly port: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly nonce: string;
}

export class StateDirLockError extends Data.TaggedError("StateDirLockError")<{
  readonly message: string;
  readonly stateDir: string;
  readonly cause?: unknown;
}> {}

export interface StateDirLockProbe {
  readonly pid: number;
  readonly hostname: () => string;
  readonly isAlive: (pid: number) => boolean;
  readonly startToken: (pid: number) => string | undefined;
}

export const defaultStateDirLockProbe: StateDirLockProbe = {
  pid: process.pid,
  hostname: () => os.hostname(),
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
  try {
    const value = JSON.parse(raw) as Partial<StateDirLockRecord>;
    if (
      value.format !== FORMAT ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      !(value.startedAt === null || typeof value.startedAt === "string") ||
      !Number.isSafeInteger(value.port) ||
      typeof value.hostname !== "string" ||
      typeof value.acquiredAt !== "string" ||
      typeof value.nonce !== "string"
    )
      return undefined;
    return value as StateDirLockRecord;
  } catch {
    return undefined;
  }
}

/** "dead" only with proof; anything unprovable is treated as a live owner. */
export function classifyStateDirLockOwner(
  owner: StateDirLockRecord,
  probe: StateDirLockProbe,
): "live" | "dead" {
  if (owner.hostname !== probe.hostname()) return "live";
  if (!probe.isAlive(owner.pid)) return "dead";
  const current = probe.startToken(owner.pid);
  if (owner.startedAt !== null && current !== undefined && current !== owner.startedAt)
    return "dead"; // The PID was reused by an unrelated process.
  return "live";
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

async function unlinkIfUnchanged(filename: string, expected: string) {
  if ((await readIfPresent(filename)) !== expected) return;
  await fs.unlink(filename).catch((cause: unknown) => {
    if (errorCode(cause) !== "ENOENT") throw cause;
  });
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
}): Promise<StateDirLockHandle> {
  const probe = input.probe ?? defaultStateDirLockProbe;
  const lockPath = path.join(input.stateDir, STATE_DIR_LOCK_FILENAME);
  await fs.mkdir(input.stateDir, { recursive: true });
  const nonce = randomBytes(16).toString("hex");
  const record: StateDirLockRecord = {
    format: FORMAT,
    pid: probe.pid,
    startedAt: probe.startToken(probe.pid) ?? null,
    port: input.port,
    hostname: probe.hostname(),
    acquiredAt: (input.now?.() ?? new Date()).toISOString(),
    nonce,
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
      });
    if (classifyStateDirLockOwner(owner, probe) === "live")
      throw new StateDirLockError({
        stateDir: input.stateDir,
        message: `Another bigbud backend (pid ${owner.pid}, port ${owner.port}) owns ${input.stateDir}; stop it or use a different BIGBUD_HOME.`,
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

/** Held for the server layer's lifetime; built before HTTP listening and persistence. */
export const StateDirLockLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => acquireStateDirLock({ stateDir: config.stateDir, port: config.port }),
        catch: (cause) =>
          cause instanceof StateDirLockError
            ? cause
            : new StateDirLockError({
                stateDir: config.stateDir,
                message: `Could not acquire the bigbud backend lock in ${config.stateDir}.`,
                cause,
              }),
      }),
      (handle) => Effect.promise(() => handle.release().catch(() => {})),
    );
  }),
);
