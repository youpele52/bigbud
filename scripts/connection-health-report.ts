#!/usr/bin/env bun
/**
 * Reports the connection-resilience health numbers from the packaged app's logs.
 *
 *   bun run scripts/connection-health-report.ts [--logs <dir>] [--trace <dir>] [--current]
 *
 * `--current` reads only the newest log and trace files, which is what a before/after
 * comparison should use after restarting the app and running the same workload.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { analyzeServerChildLog, analyzeTrace } from "./connection-health-report.lib.ts";

const argValue = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const logsDir =
  argValue("--logs") ?? join(homedir(), "Library", "Application Support", "bigbud", "logs");
const traceDir = argValue("--trace") ?? join(homedir(), ".bigbud", "userdata", "logs");
const currentOnly = process.argv.includes("--current");

const filesFor = (dir: string, base: string) => {
  if (!existsSync(dir)) return [];
  const rotated = (name: string) => Number(name.slice(base.length + 1)) || 0;
  return readdirSync(dir)
    .filter((name) => name === base || (!currentOnly && name.startsWith(`${base}.`)))
    .toSorted((left, right) => rotated(right) - rotated(left))
    .map((name) => join(dir, name));
};

const childLogs = filesFor(logsDir, "server-child.log");
const traces = filesFor(traceDir, "server.trace.ndjson");
const child = analyzeServerChildLog(childLogs.map((file) => readFileSync(file, "utf8")).join("\n"));
const trace = analyzeTrace(traces.flatMap((file) => readFileSync(file, "utf8").split("\n")));

const rows: Array<readonly [string, number, string]> = [
  ["Heap out-of-memory aborts", child.heapOutOfMemoryAborts, "0"],
  ["Event-loop stalls over 1 s", child.stalls.overOneSecond, "falling"],
  ["Event-loop stalls over 5 s", child.stalls.overFiveSeconds, "0"],
  ["Longest stall (ms)", child.longestStallMs, "< 5000"],
  ["Discovery scans", child.discoveryScans, "falling"],
  ["Peak discovery scans per 10 min", child.peakDiscoveryScansPerTenMinutes, "< 30"],
  ["Traced stalls over 5 s", trace.stallsOverFiveSeconds, "0"],
  ["SQL spans over 10 s", trace.sqlSpansOverTenSeconds, "falling"],
  ["Socket reconnects", trace.reconnects, "info"],
  ["Reconnects without a delivery session", trace.reconnectsWithoutDeliverySession, "0"],
];

console.log(`server-child logs: ${childLogs.length} file(s) in ${logsDir}`);
console.log(`trace files:       ${traces.length} file(s) in ${traceDir}\n`);
const width = Math.max(...rows.map(([label]) => label.length));
for (const [label, value, target] of rows) {
  console.log(`${label.padEnd(width)}  ${String(value).padStart(8)}   target ${target}`);
}
