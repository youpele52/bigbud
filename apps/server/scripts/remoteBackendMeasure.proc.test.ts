import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectTree,
  cpuBetween,
  parseStat,
  readProcTable,
  type ProcessRoot,
} from "./remoteBackendMeasure.proc.ts";

const roots: ReadonlyArray<ProcessRoot> = [
  { role: "backend", pid: 100 },
  { role: "rust", pid: 200 },
];

let procRoot: string | undefined;
afterEach(() => {
  if (procRoot) rmSync(procRoot, { recursive: true, force: true });
  procRoot = undefined;
});

/** A `/proc/<pid>/stat` line: utime is field 14, stime 15, starttime 22. */
function statLine(pid: number, name: string, ppid: number, utime: number, stime = 0, start = 50) {
  const fields = Array.from({ length: 50 }, () => "0");
  fields[0] = "S";
  fields[1] = String(ppid);
  fields[11] = String(utime);
  fields[12] = String(stime);
  fields[19] = String(start);
  return `${pid} (${name}) ${fields.join(" ")}\n`;
}

function writeProc(
  root: string,
  processes: ReadonlyArray<{ pid: number; name: string; ppid: number; rss?: number; cpu: number }>,
) {
  for (const entry of processes) {
    const dir = join(root, String(entry.pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stat"), statLine(entry.pid, entry.name, entry.ppid, entry.cpu));
    writeFileSync(
      join(dir, "status"),
      `Name:\t${entry.name}\n${entry.rss === undefined ? "" : `VmRSS:\t ${entry.rss} kB\n`}`,
    );
  }
  mkdirSync(join(root, "self"), { recursive: true });
  writeFileSync(join(root, "uptime"), "1.00 1.00\n");
}

function cpuTable(cpu: number, childStart: number) {
  return new Map([
    [100, { pid: 100, ppid: 1, name: "node", rssKiB: 1, cpuTicks: cpu, startTicks: 10 }],
    [101, { pid: 101, ppid: 100, name: "c", rssKiB: 1, cpuTicks: 30, startTicks: childStart }],
  ]);
}

describe("remote backend measurement /proc tree", () => {
  it("measure_tree_includes_children", () => {
    procRoot = mkdtempSync(join(tmpdir(), "bb-measure-proc-"));
    writeProc(procRoot, [
      { pid: 1, name: "systemd", ppid: 0, rss: 9000, cpu: 900 },
      { pid: 100, name: "node", ppid: 1, rss: 150_000, cpu: 40 },
      { pid: 101, name: "codex (fake)", ppid: 100, rss: 40_000, cpu: 5 },
      { pid: 102, name: "node", ppid: 101, rss: 10_000, cpu: 1 },
      { pid: 200, name: "bigbud-remote-agent", ppid: 1, rss: 4_000, cpu: 2 },
      { pid: 201, name: "bash", ppid: 200, rss: 3_000, cpu: 1 },
      { pid: 300, name: "unrelated", ppid: 1, rss: 99_999, cpu: 99 },
      { pid: 400, name: "kworker/0:1", ppid: 2, cpu: 7 },
    ]);

    const sample = collectTree(readProcTable(procRoot), roots);

    expect(sample.runtimeOnly).toEqual({ processCount: 2, rssKiB: 154_000, cpuTicks: 42 });
    expect(sample.inclusive).toEqual({ processCount: 5, rssKiB: 207_000, cpuTicks: 49 });
    expect(sample.processes.map((entry) => [entry.pid, entry.role]).toSorted()).toEqual([
      [100, "backend"],
      [101, "backend"],
      [102, "backend"],
      [200, "rust"],
      [201, "rust"],
    ]);
    expect(sample.processes.find((entry) => entry.pid === 101)?.name).toBe("codex (fake)");
  });

  it("skips a missing root and parses names with spaces and parentheses", () => {
    expect(parseStat(statLine(7, "a (b) c", 3, 11, 4, 99))).toEqual({
      pid: 7,
      name: "a (b) c",
      ppid: 3,
      cpuTicks: 15,
      startTicks: 99,
    });
    procRoot = mkdtempSync(join(tmpdir(), "bb-measure-proc-"));
    writeProc(procRoot, [{ pid: 100, name: "node", ppid: 1, rss: 10, cpu: 1 }]);
    const sample = collectTree(readProcTable(procRoot), roots);
    expect(sample.inclusive.processCount).toBe(1);
  });

  it("computes CPU per window and ignores reused PIDs", () => {
    const before = collectTree(cpuTable(100, 20), roots);
    const after = collectTree(cpuTable(150, 25), roots);
    // 50 ticks of the root in 1 s at 100 Hz is half a core; the child is a new process (PID reuse).
    expect(cpuBetween(before, after, 1000, 100)).toEqual({
      runtimeOnlyPercent: 50,
      inclusivePercent: 80,
    });
  });
});
