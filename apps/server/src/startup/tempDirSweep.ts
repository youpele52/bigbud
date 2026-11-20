/**
 * Startup sweep of temporary directories a crashed backend left behind (F-B7).
 *
 * Provider sessions create private directories under the OS temp directory and remove them when
 * the session ends. A crash or SIGKILL skips that cleanup. At startup this sweep removes such a
 * directory only when every check passes:
 *
 * 1. it sits directly in the temp directory and its name is a known bigbud prefix followed by
 *    the six-character `mkdtemp` suffix ({@link BIGBUD_TEMP_DIR_RULES});
 * 2. it is a real directory (not a symlink) owned by this user;
 * 3. it is stale: untouched for at least the rule's `minAgeMs`;
 * 4. for session bridges, its owner is gone: the `.bigbud/owner.json` marker names a process that
 *    no longer exists. A bridge without a marker (written by an older version) must carry the
 *    bridge file and be older than {@link LEGACY_BRIDGE_MIN_AGE_MS}.
 *
 * A live backend's directories therefore never match: its process is alive, and a command
 * sandbox lives for at most its 30-second command timeout. Each run removes at most
 * {@link TEMP_DIR_SWEEP_MAX_REMOVALS} directories; the rest wait for the next start.
 *
 * @module tempDirSweep
 */
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";

const HOUR_MS = 60 * 60_000;
/** A marker-less bridge from an older version is swept only after a week. */
export const LEGACY_BRIDGE_MIN_AGE_MS = 7 * 24 * HOUR_MS;
/** Upper bound on directories removed by one startup sweep. */
export const TEMP_DIR_SWEEP_MAX_REMOVALS = 256;

export interface BigbudTempDirRule {
  readonly prefix: string;
  readonly minAgeMs: number;
  /** Relative path every directory of this kind contains; also the legacy-marker fallback. */
  readonly bridgeFile?: string;
}

export const BIGBUD_TEMP_DIR_RULES: ReadonlyArray<BigbudTempDirRule> = [
  {
    prefix: "bigbud-orchestration-mcp-",
    minAgeMs: HOUR_MS,
    bridgeFile: ".bigbud/orchestration-mcp-server.mjs",
  },
  {
    prefix: "bigbud-pi-orchestration-",
    minAgeMs: HOUR_MS,
    bridgeFile: ".bigbud/bigbud-orchestration-bridge.ts",
  },
  // HOME/TMPDIR of one sandboxed V2 command, bounded by its 30 s command timeout.
  { prefix: "bigbud-v2-exec-", minAgeMs: HOUR_MS },
];

const OWNER_MARKER = path.join(".bigbud", "owner.json");
const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;

/** Records the creating process so a later sweep can tell a crashed owner from a live one. */
export async function writeBigbudTempDirOwner(dir: string): Promise<void> {
  await writeFile(path.join(dir, OWNER_MARKER), JSON.stringify({ pid: process.pid }), {
    encoding: "utf8",
    mode: 0o600,
  });
}

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function ownerGone(dir: string, rule: BigbudTempDirRule, ageMs: number): Promise<boolean> {
  if (!rule.bridgeFile) return true;
  if (!(await exists(path.join(dir, rule.bridgeFile)))) return false;
  const marker = await readFile(path.join(dir, OWNER_MARKER), "utf8").catch(() => undefined);
  if (marker === undefined) return ageMs >= LEGACY_BRIDGE_MIN_AGE_MS;
  try {
    const pid = (JSON.parse(marker) as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    return pid !== process.pid && !processAlive(pid);
  } catch {
    return false;
  }
}

export interface TempDirSweepOptions {
  readonly tempDir?: string;
  readonly nowMs?: number;
  readonly rules?: ReadonlyArray<BigbudTempDirRule>;
}

/** Removes verified stale bigbud temp directories; returns the removed paths. */
export async function sweepStaleBigbudTempDirs(
  options: TempDirSweepOptions = {},
): Promise<ReadonlyArray<string>> {
  const tempDir = options.tempDir ?? os.tmpdir();
  const nowMs = options.nowMs ?? Date.now();
  const rules = options.rules ?? BIGBUD_TEMP_DIR_RULES;
  const uid = process.getuid?.();
  const removed: Array<string> = [];
  for (const name of await readdir(tempDir).catch(() => [] as Array<string>)) {
    if (removed.length >= TEMP_DIR_SWEEP_MAX_REMOVALS) break;
    const rule = rules.find((candidate) => name.startsWith(candidate.prefix));
    if (!rule || !MKDTEMP_SUFFIX.test(name.slice(rule.prefix.length))) continue;
    const dir = path.join(tempDir, name);
    const stats = await lstat(dir).catch(() => undefined);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) continue;
    if (uid !== undefined && stats.uid !== uid) continue;
    const ageMs = nowMs - stats.mtimeMs;
    if (ageMs < rule.minAgeMs) continue;
    if (!(await ownerGone(dir, rule, ageMs))) continue;
    await rm(dir, { recursive: true, force: true }).then(
      () => removed.push(dir),
      () => undefined,
    );
  }
  return removed;
}

/** Background startup step: never fails startup, logs what it removed. */
export const sweepStaleBigbudTempDirsAtStartup = Effect.fn("sweepStaleBigbudTempDirsAtStartup")(
  function* () {
    const removed = yield* Effect.promise(() => sweepStaleBigbudTempDirs());
    if (removed.length > 0) {
      yield* Effect.logInfo("removed stale bigbud temp directories", { count: removed.length });
    }
  },
);
