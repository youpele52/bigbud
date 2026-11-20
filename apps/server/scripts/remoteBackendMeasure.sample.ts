/**
 * Live sampling for the remote backend measurement (WP-6A): unit PIDs, process-tree windows,
 * database sizes and latency statistics. Read-only.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

import {
  collectTree,
  cpuBetween,
  readProcTable,
  type ProcessRoot,
  type TreeSample,
} from "./remoteBackendMeasure.proc.ts";

export interface UnitPids {
  readonly backend: number;
  readonly rust: number;
}

export function unitNames(authorityId: string) {
  return {
    backend: `bigbud-backend-${authorityId}.service`,
    rust: `bigbud-rust-${authorityId}.service`,
  };
}

function systemctlUser(args: ReadonlyArray<string>): string {
  return execFileSync("systemctl", ["--user", "--no-ask-password", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

export function readUnitPids(authorityId: string): UnitPids {
  const names = unitNames(authorityId);
  const pid = (unit: string) => Number(systemctlUser(["show", "-p", "MainPID", "--value", unit]));
  return { backend: pid(names.backend), rust: pid(names.rust) };
}

/**
 * Queue a restart of only the backend unit (`--no-block`: a graceful stop can outlast any
 * synchronous call). The Rust unit and its terminals keep running. Resolves once systemd
 * reports a new main PID, with the time that took (the old backend's stop).
 */
export async function restartBackendUnit(
  authorityId: string,
  previousPid: number,
  deadlineMs: number,
): Promise<{ readonly newPid: number; readonly stopMs: number }> {
  const started = performance.now();
  systemctlUser(["restart", "--no-block", unitNames(authorityId).backend]);
  while (performance.now() - started < deadlineMs) {
    const pid = readUnitPids(authorityId).backend;
    if (pid !== 0 && pid !== previousPid)
      return { newPid: pid, stopMs: performance.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend did not restart within ${deadlineMs} ms`);
}

export function clockTicksPerSecond(): number {
  try {
    const value = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
    return Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    return 100;
  }
}

export function rootsOf(pids: UnitPids): ReadonlyArray<ProcessRoot> {
  return [
    { role: "backend", pid: pids.backend },
    { role: "rust", pid: pids.rust },
  ];
}

export interface ResourceWindow {
  readonly durationMs: number;
  readonly samples: number;
  readonly runtimeOnly: { readonly peakRssKiB: number; readonly cpuPercent: number };
  readonly inclusive: {
    readonly peakRssKiB: number;
    readonly cpuPercent: number;
    readonly peakProcessCount: number;
  };
  readonly lastProcesses: ReadonlyArray<{
    pid: number;
    role: string;
    name: string;
    rssKiB: number;
  }>;
}

/**
 * Sample the two trees every `intervalMs` while `work` runs (or for `idleMs` when there is
 * none). CPU is the average over the window; RSS and process counts are peaks.
 */
export async function sampleWindow(
  pids: UnitPids,
  options: { readonly intervalMs: number; readonly idleMs?: number; readonly procRoot?: string },
  work?: () => Promise<unknown>,
): Promise<ResourceWindow> {
  const roots = rootsOf(pids);
  const take = () => collectTree(readProcTable(options.procRoot), roots);
  const first: TreeSample = take();
  const started = performance.now();
  let last = first;
  let samples = 1;
  let peakRuntime = first.runtimeOnly.rssKiB;
  let peakInclusive = first.inclusive.rssKiB;
  let peakCount = first.inclusive.processCount;
  const tick = () => {
    last = take();
    samples += 1;
    peakRuntime = Math.max(peakRuntime, last.runtimeOnly.rssKiB);
    peakInclusive = Math.max(peakInclusive, last.inclusive.rssKiB);
    peakCount = Math.max(peakCount, last.inclusive.processCount);
  };
  const timer = setInterval(tick, options.intervalMs);
  try {
    if (work) await work();
    else await new Promise((resolve) => setTimeout(resolve, options.idleMs ?? 5_000));
  } finally {
    clearInterval(timer);
  }
  tick();
  const durationMs = performance.now() - started;
  const cpu = cpuBetween(first, last, durationMs, clockTicksPerSecond());
  return {
    durationMs: Math.round(durationMs),
    samples,
    runtimeOnly: { peakRssKiB: peakRuntime, cpuPercent: round(cpu.runtimeOnlyPercent) },
    inclusive: {
      peakRssKiB: peakInclusive,
      cpuPercent: round(cpu.inclusivePercent),
      peakProcessCount: peakCount,
    },
    lastProcesses: last.processes.map(({ pid, role, name, rssKiB }) => ({
      pid,
      role,
      name,
      rssKiB,
    })),
  };
}

export interface DatabaseSize {
  readonly dbBytes: number;
  readonly walBytes: number;
  readonly shmBytes: number;
  readonly totalBytes: number;
}

export function databaseSize(stateDir: string): DatabaseSize {
  const size = (name: string) => {
    try {
      return statSync(join(stateDir, name)).size;
    } catch {
      return 0;
    }
  };
  const dbBytes = size("state.sqlite");
  const walBytes = size("state.sqlite-wal");
  const shmBytes = size("state.sqlite-shm");
  return { dbBytes, walBytes, shmBytes, totalBytes: dbBytes + walBytes + shmBytes };
}

export interface LatencyStats {
  readonly samples: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function latencyStats(values: ReadonlyArray<number>): LatencyStats {
  if (values.length === 0) return { samples: 0, minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };
  const sorted = values.toSorted((left, right) => left - right);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return {
    samples: sorted.length,
    minMs: round(sorted[0]!),
    medianMs: round(at(0.5)),
    p95Ms: round(at(0.95)),
    maxMs: round(sorted.at(-1)!),
  };
}

export async function repeat(count: number, run: () => Promise<number>): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) values.push(await run());
  return values;
}
