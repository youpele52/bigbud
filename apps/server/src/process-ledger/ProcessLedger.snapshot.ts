/**
 * One process-table snapshot for the startup reaper: a single asynchronous `ps` call instead of a
 * synchronous probe per recorded child, so reaping many orphans never stalls the event loop.
 *
 * @module ProcessLedger.snapshot
 */
import { execFile } from "node:child_process";

import {
  PS_PROBE_ENV,
  processStartToken,
  psLstartStartToken,
} from "@bigbud/shared/processStartToken";

export interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** `ps lstart` under the fixed C locale and UTC (`PS_PROBE_ENV`). */
  readonly lstart: string;
  readonly command: string;
}

export type ProcessTable = ReadonlyMap<number, ProcessTableRow>;

const PS_SNAPSHOT_TIMEOUT_MS = 5_000;
const PS_SNAPSHOT_MAX_BUFFER = 64 * 1024 * 1024;
// pid ppid pgid, then lstart ("Tue Oct  7 14:49:52 2026", five fields), then the command line.
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/;

export function parseProcessTable(stdout: string): ProcessTable {
  const table = new Map<number, ProcessTableRow>();
  for (const line of stdout.split("\n")) {
    const match = ROW.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, lstart, command] = match;
    table.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      lstart: lstart!,
      command: command!,
    });
  }
  return table;
}

/** The whole process table, or undefined when it cannot be read (Windows, `ps` failure). */
export function readProcessTable(): Promise<ProcessTable | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "ps",
      // `-A -ww`: every process, unlimited width; accepted by BSD/macOS and procps-ng `ps`.
      ["-A", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,command="],
      {
        encoding: "utf8",
        env: PS_PROBE_ENV,
        timeout: PS_SNAPSHOT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: PS_SNAPSHOT_MAX_BUFFER,
      },
      (error, stdout) => resolve(error ? undefined : parseProcessTable(stdout)),
    );
  });
}

/**
 * Start token comparable with `processStartToken`: Linux reads `/proc` (cheap, and the scheme
 * recorded there); other POSIX systems reuse the snapshot's `lstart`.
 */
export function rowStartToken(row: ProcessTableRow): string | undefined {
  return process.platform === "linux" ? processStartToken(row.pid) : psLstartStartToken(row.lstart);
}

/** Every descendant of `rootPid` by parent PID, nearest first; the root itself is excluded. */
export function descendantsOf(table: ProcessTable, rootPid: number): ReadonlyArray<number> {
  const children = new Map<number, number[]>();
  for (const row of table.values()) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const result: number[] = [];
  const seen = new Set([rootPid]);
  for (let queue = [rootPid]; queue.length > 0; ) {
    const next: number[] = [];
    for (const pid of queue) {
      for (const child of children.get(pid) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        result.push(child);
        next.push(child);
      }
    }
    queue = next;
  }
  return result;
}
