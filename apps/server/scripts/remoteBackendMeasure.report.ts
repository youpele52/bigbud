/** JSON and markdown output for the remote backend measurement (WP-6A). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseSize, LatencyStats, ResourceWindow } from "./remoteBackendMeasure.sample.ts";

export interface LevelResult {
  readonly sessions: number;
  readonly historyTurnsPerSession: number;
  readonly measuredTurnsPerSession: number;
  readonly turnLatency: LatencyStats;
  readonly window: ResourceWindow;
  readonly idleAfter: ResourceWindow;
  readonly databaseBefore: DatabaseSize;
  readonly databaseAfter: DatabaseSize;
  readonly reconnect: LatencyStats;
}

export interface MeasurementResult {
  readonly tool: "remoteBackendMeasure";
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly host: {
    readonly arch: string;
    readonly kernel: string;
    readonly cpus: number;
    readonly memTotalKiB: number;
  };
  readonly authorityId: string;
  readonly pids: { readonly backend: number; readonly rust: number };
  readonly idle: ResourceWindow;
  readonly handshake: LatencyStats;
  readonly reconnectIdle: LatencyStats;
  readonly readiness: null | {
    /** `systemctl restart` until systemd reports the new main PID (the old backend's stop). */
    readonly stopMs: number;
    /** New main PID until the first successful handshake. */
    readonly startToReadyMs: number;
    readonly restartToReadyMs: number;
    readonly firstReconnectMs: number;
    readonly idleAfterRestart: ResourceWindow;
  };
  readonly databaseInitial: DatabaseSize;
  readonly databaseAfterCleanup: DatabaseSize | null;
  readonly levels: ReadonlyArray<LevelResult>;
  readonly cleanupProblems: ReadonlyArray<string>;
}

const mib = (kib: number) => (kib / 1024).toFixed(1);
const mibBytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
const lat = (stats: LatencyStats) => `${stats.medianMs} / ${stats.p95Ms} / ${stats.maxMs}`;

export function renderMarkdown(result: MeasurementResult): string {
  const lines = [
    `# Remote backend measurement ${result.startedAt.slice(0, 10)}`,
    "",
    `Host: ${result.host.arch}, kernel ${result.host.kernel}, ${result.host.cpus} CPUs, ` +
      `${mib(result.host.memTotalKiB)} MiB memory. Authority \`${result.authorityId}\`.`,
    "Runtime-only = backend main process + Rust supervisor. Inclusive = both full process trees",
    "(provider processes, PTY shells, workers). CPU is % of one core averaged over the window.",
    "Latencies are median / p95 / max in ms.",
    "",
    "## Idle and latency",
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Idle RSS runtime-only / inclusive (MiB) | ${mib(result.idle.runtimeOnly.peakRssKiB)} / ${mib(result.idle.inclusive.peakRssKiB)} |`,
    `| Idle CPU runtime-only / inclusive (%) | ${result.idle.runtimeOnly.cpuPercent} / ${result.idle.inclusive.cpuPercent} |`,
    `| Handshake round trip | ${lat(result.handshake)} |`,
    `| Client reconnect (WS open + config + thread detail), idle | ${lat(result.reconnectIdle)} |`,
    result.readiness
      ? `| Backend restart: stop / new process → ready / total | ${Math.round(result.readiness.stopMs)} / ${Math.round(result.readiness.startToReadyMs)} / ${Math.round(result.readiness.restartToReadyMs)} ms |`
      : "| Backend restart → ready | not measured (pass --restart-for-readiness) |",
    result.readiness
      ? `| First client reconnect after ready | ${Math.round(result.readiness.firstReconnectMs)} ms |`
      : undefined,
    `| DB+WAL+SHM initial | ${mibBytes(result.databaseInitial.totalBytes)} MiB |`,
    result.databaseAfterCleanup
      ? `| DB+WAL+SHM after cleanup | ${mibBytes(result.databaseAfterCleanup.totalBytes)} MiB |`
      : undefined,
    "",
    "## Concurrent fake-provider sessions",
    "",
    "| Sessions | Turn latency | Peak RSS runtime / inclusive (MiB) | CPU runtime / inclusive (%) | Peak processes | Idle-after RSS runtime / inclusive (MiB) | DB+WAL before → after (MiB) | WAL after (MiB) | Reconnect |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...result.levels.map(
      (level) =>
        `| ${level.sessions} | ${lat(level.turnLatency)} | ${mib(level.window.runtimeOnly.peakRssKiB)} / ${mib(level.window.inclusive.peakRssKiB)} | ` +
        `${level.window.runtimeOnly.cpuPercent} / ${level.window.inclusive.cpuPercent} | ${level.window.inclusive.peakProcessCount} | ` +
        `${mib(level.idleAfter.runtimeOnly.peakRssKiB)} / ${mib(level.idleAfter.inclusive.peakRssKiB)} | ` +
        `${mibBytes(level.databaseBefore.totalBytes)} → ${mibBytes(level.databaseAfter.totalBytes)} | ${mibBytes(level.databaseAfter.walBytes)} | ${lat(level.reconnect)} |`,
    ),
    "",
    result.cleanupProblems.length === 0
      ? "Cleanup: all measurement threads, the project and the Codex settings were restored."
      : `Cleanup problems: ${result.cleanupProblems.join("; ")}`,
    "",
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}

export function writeOutputs(outDir: string, result: MeasurementResult) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = result.startedAt.replaceAll(":", "").replace(/\.\d+Z$/u, "Z");
  const json = join(outDir, `remote-backend-measure-${stamp}.json`);
  const markdown = join(outDir, `remote-backend-measure-${stamp}.md`);
  writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdown, renderMarkdown(result), { mode: 0o600 });
  return { json, markdown };
}
