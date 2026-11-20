/**
 * Read-only `/proc` sampling for the remote backend measurement (WP-6A).
 *
 * Plain TypeScript with only `node:` imports so the graph's private Node can run it on a VPS
 * (type stripping), with no repository dependencies. Every function takes `procRoot` so tests
 * can use a fake `/proc` tree.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProcEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  /** Resident set size in KiB (`VmRSS`); 0 for kernel threads or exited processes. */
  readonly rssKiB: number;
  /** utime + stime in clock ticks. */
  readonly cpuTicks: number;
  /** Process start time in clock ticks after boot. */
  readonly startTicks: number;
}

export type ProcTable = ReadonlyMap<number, ProcEntry>;

export interface ProcessRoot {
  /** `backend` is the Node server; `rust` is the Rust supervisor (bigbud-remote-agent). */
  readonly role: "backend" | "rust";
  readonly pid: number;
}

export interface TreeProcess extends ProcEntry {
  readonly role: ProcessRoot["role"];
  readonly isRoot: boolean;
}

export interface TreeTotals {
  readonly processCount: number;
  readonly rssKiB: number;
  readonly cpuTicks: number;
}

export interface TreeSample {
  /** Only the two runtime processes: backend main process and Rust supervisor. */
  readonly runtimeOnly: TreeTotals;
  /** Both full process trees, including providers, PTY shells and other children. */
  readonly inclusive: TreeTotals;
  readonly processes: ReadonlyArray<TreeProcess>;
}

/** Parse `/proc/<pid>/stat`; the command name may contain spaces and parentheses. */
export function parseStat(
  text: string,
): Pick<ProcEntry, "pid" | "ppid" | "name" | "cpuTicks" | "startTicks"> {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error("Malformed /proc stat line.");
  const pid = Number(text.slice(0, open).trim());
  const name = text.slice(open + 1, close);
  // Fields after the name start at field 3 (state); index 0 here is field 3.
  const rest = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const field = (n: number) => Number(rest[n - 3]);
  return {
    pid,
    name,
    ppid: field(4),
    cpuTicks: field(14) + field(15),
    startTicks: field(22),
  };
}

export function parseVmRssKiB(statusText: string): number {
  const match = /^VmRSS:\s+(\d+)\s+kB/mu.exec(statusText);
  return match ? Number(match[1]) : 0;
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Snapshot every process. Processes that exit while being read are skipped. */
export function readProcTable(procRoot = "/proc"): ProcTable {
  const table = new Map<number, ProcEntry>();
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(name)) continue;
    const stat = readOptional(join(procRoot, name, "stat"));
    if (stat === undefined) continue;
    try {
      const parsed = parseStat(stat);
      const status = readOptional(join(procRoot, name, "status")) ?? "";
      table.set(parsed.pid, { ...parsed, rssKiB: parseVmRssKiB(status) });
    } catch {
      continue;
    }
  }
  return table;
}

function totals(list: ReadonlyArray<TreeProcess>): TreeTotals {
  return {
    processCount: list.length,
    rssKiB: list.reduce((sum, entry) => sum + entry.rssKiB, 0),
    cpuTicks: list.reduce((sum, entry) => sum + entry.cpuTicks, 0),
  };
}

/** Walk each root's descendants by parent PID. A PID is attributed to the first root reaching it. */
export function collectTree(table: ProcTable, roots: ReadonlyArray<ProcessRoot>): TreeSample {
  const children = new Map<number, number[]>();
  for (const entry of table.values()) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const seen = new Set<number>();
  const processes: TreeProcess[] = [];
  for (const root of roots) {
    const stack = [root.pid];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      const entry = table.get(pid);
      if (entry === undefined) continue;
      seen.add(pid);
      processes.push({ ...entry, role: root.role, isRoot: pid === root.pid });
      stack.push(...(children.get(pid) ?? []));
    }
  }
  return {
    runtimeOnly: totals(processes.filter((entry) => entry.isRoot)),
    inclusive: totals(processes),
    processes,
  };
}

export interface CpuWindow {
  readonly runtimeOnlyPercent: number;
  readonly inclusivePercent: number;
}

/**
 * CPU use between two samples, as a percentage of one core. Processes that exited between the
 * samples are not counted; processes that started count their whole CPU time.
 */
export function cpuBetween(
  before: TreeSample,
  after: TreeSample,
  elapsedMs: number,
  clockTicksPerSecond: number,
): CpuWindow {
  const previous = new Map(before.processes.map((entry) => [entry.pid, entry]));
  const delta = (list: ReadonlyArray<TreeProcess>) =>
    list.reduce((sum, entry) => {
      const prior = previous.get(entry.pid);
      const base =
        prior !== undefined && prior.startTicks === entry.startTicks ? prior.cpuTicks : 0;
      return sum + Math.max(0, entry.cpuTicks - base);
    }, 0);
  const percent = (ticks: number) =>
    elapsedMs <= 0 ? 0 : (ticks / clockTicksPerSecond / (elapsedMs / 1000)) * 100;
  return {
    runtimeOnlyPercent: percent(delta(after.processes.filter((entry) => entry.isRoot))),
    inclusivePercent: percent(delta(after.processes)),
  };
}
