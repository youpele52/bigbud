import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Versioned prefix of every token this helper produces. Tokens without it were written by older
 * builds (locale/time-zone dependent `ps lstart`, or a `pid:` placeholder) and are never comparable:
 * callers must treat them as unprovable and fail closed, never as proof of PID reuse.
 */
export const PROCESS_START_TOKEN_PREFIX = "start-v2:";

/** Linux: boot id plus `/proc/<pid>/stat` field 22 (start time in clock ticks since boot). */
function linuxStartToken(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 2 (comm) may contain spaces and parentheses; fields resume after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = fields[19]; // Field 22 overall; field 3 is fields[0].
    if (!ticks || !/^\d+$/.test(ticks)) return undefined;
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${PROCESS_START_TOKEN_PREFIX}linux:${boot}:${ticks}`;
  } catch {
    return undefined;
  }
}

/** Bound for the synchronous `ps` probe; it only reads local process state. */
const PS_START_TOKEN_TIMEOUT_MS = 2_000;

/** Other POSIX: `ps lstart` under a fixed C locale and UTC, so the caller's TZ/LC_* cannot vary it. */
function psStartToken(pid: number): string | undefined {
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PS_START_TOKEN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" },
    }).trim();
    return value
      ? `${PROCESS_START_TOKEN_PREFIX}ps-utc:${value.replaceAll(/\s+/g, "_")}`
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Environment-independent start-time token for a live process, used to tell a recorded owner from
 * an unrelated process that later reused its PID. `undefined` when unobtainable (for example on
 * Windows, or when the process is gone); callers must then fail closed.
 */
export function processStartToken(pid: number): string | undefined {
  return linuxStartToken(pid) ?? psStartToken(pid);
}

const scheme = (token: string | null | undefined) =>
  token?.startsWith(PROCESS_START_TOKEN_PREFIX)
    ? token.slice(PROCESS_START_TOKEN_PREFIX.length).split(":", 1)[0]
    : undefined;

/**
 * Compare a recorded token with the current owner's token. Only two comparable tokens of the same
 * scheme that differ prove PID reuse ("different"); a missing, legacy, unobtainable or
 * other-scheme token is "unknown".
 */
export function compareProcessStartToken(
  recorded: string | null | undefined,
  current: string | undefined,
): "same" | "different" | "unknown" {
  const kind = scheme(recorded);
  if (!kind || kind !== scheme(current)) return "unknown";
  return recorded === current ? "same" : "different";
}
