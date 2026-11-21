/**
 * Host process sampling for the terminal host soak (plan Q1 (b)): RSS and open file descriptors
 * of every live host PID, and the `terminal host stats:` line the host writes to its
 * `supervisor.log` when `BIGBUD_DEBUG_TERMINAL_HOST_STATS_MS` is set (live PTYs, workspace roots,
 * owners). Also the small statistics the report needs.
 *
 * @module terminalHostSoak.sample
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface HostSample {
  readonly atMs: number;
  readonly hostPids: ReadonlyArray<number>;
  readonly rssKiB: number;
  readonly fds: number;
  readonly livePtys: number | null;
  readonly workspaceRoots: number | null;
  readonly owners: number | null;
}

function rssKiB(pid: number): number {
  try {
    return Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim(),
    );
  } catch {
    return 0;
  }
}

function openFds(pid: number): number {
  if (process.platform === "linux") {
    try {
      return readdirSync(`/proc/${pid}/fd`).length;
    } catch {
      return 0;
    }
  }
  try {
    const text = execFileSync("lsof", ["-n", "-P", "-p", String(pid), "-F", "f"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // One `f<descriptor>` line per open file; skip cwd/txt/mem pseudo entries.
    return text.split("\n").filter((line) => /^f\d+$/.test(line)).length;
  } catch {
    return 0;
  }
}

const STATS = /terminal host stats: live_ptys=(\d+) workspace_roots=(\d+) owners=(\d+)/g;

/** The newest stats line across every generation's supervisor log. */
function latestStats(stateDir: string) {
  const root = join(stateDir, "terminal-host");
  let newest: { at: number; live: number; roots: number; owners: number } | undefined;
  let entries: string[] = [];
  try {
    entries = readdirSync(root).filter((name) => name.startsWith("state-"));
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const log = join(root, entry, "supervisor.log");
    let text: string;
    let at: number;
    try {
      at = statSync(log).mtimeMs;
      text = readFileSync(log, "utf8").slice(-16_384);
    } catch {
      continue;
    }
    const matches = [...text.matchAll(STATS)];
    const last = matches.at(-1);
    if (!last || (newest && newest.at > at)) continue;
    newest = { at, live: Number(last[1]), roots: Number(last[2]), owners: Number(last[3]) };
  }
  return newest;
}

export function sampleHost(stateDir: string, hostPids: ReadonlyArray<number>): HostSample {
  const stats = latestStats(stateDir);
  return {
    atMs: Date.now(),
    hostPids,
    rssKiB: hostPids.reduce((sum, pid) => sum + rssKiB(pid), 0),
    fds: hostPids.reduce((sum, pid) => sum + openFds(pid), 0),
    livePtys: stats?.live ?? null,
    workspaceRoots: stats?.roots ?? null,
    owners: stats?.owners ?? null,
  };
}

export function percentile(values: ReadonlyArray<number>, percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.max(0, Math.ceil((sorted.length * percent) / 100) - 1);
  return sorted[index] ?? null;
}

export const median = (values: ReadonlyArray<number>) => percentile(values, 50);
