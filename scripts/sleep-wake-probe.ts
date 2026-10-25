#!/usr/bin/env node
/**
 * Dev-only sleep-and-wake probe for connection resilience Phase 6. It never writes to
 * bigbud's database or logs; it only reads them and samples its own clocks.
 *
 *   node scripts/sleep-wake-probe.ts start --scenario streaming --planned-sleep 10
 *   node scripts/sleep-wake-probe.ts analyze <run dir>
 *   node scripts/sleep-wake-probe.ts table [results.ndjson]
 *
 * See docs/research/Sleep and wake provider conformance/README.md for the procedure.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { analyzeProbeRun } from "./lib/sleep-wake-probe.analyze.ts";
import {
  CLOCK_SAMPLE_INTERVAL_MS,
  TRACE_OFFSET_SAMPLE_INTERVAL_MS,
} from "./lib/sleep-wake-probe.clock.ts";
import { formatSummary, formatTableHeader, formatTableRow } from "./lib/sleep-wake-probe.report.ts";
import {
  appendNdjson,
  collectProbeInputs,
  createRunDir,
  REPO_ROOT,
  RESULTS_FILE,
  RUN_FILES,
  saveRow,
  writeProviderVersion,
} from "./lib/sleep-wake-probe.run.ts";
import {
  defaultDesktopLogPath,
  defaultStateDir,
  isProbeChannel,
  PROBE_CHANNELS,
  type ProbeChannel,
} from "./lib/sleep-wake-probe.paths.ts";
import {
  detectProviderVersion,
  readMaxSequence,
  sampleTraceOffset,
} from "./lib/sleep-wake-probe.sources.ts";
import type {
  ProbeBuild,
  ProbeRunMeta,
  ProbeScenario,
  ProbeTopology,
  SleepWakeRunRow,
} from "./lib/sleep-wake-probe.types.ts";

const DEFAULT_OUT_DIR = path.join(tmpdir(), "bigbud-sleep-wake-probe");

const USAGE = `Usage:
  node scripts/sleep-wake-probe.ts start [options]   start a run, wait for Enter, analyse
  node scripts/sleep-wake-probe.ts analyze <run dir> re-analyse a saved run
  node scripts/sleep-wake-probe.ts table [file]      print results.ndjson as Markdown rows

start options:
  --scenario streaming|tool   what the turn is doing when the lid closes (required)
  --planned-sleep <minutes>   1, 10 or 30
  --provider <kind>           read the provider version before sleeping (else after)
  --thread <id>               the thread under test (default: first turn started)
  --marker <file>             marker file the tool command appends to (required for tool runs)
  --remote                    SSH remote project; use a fresh marker file per run
  --packaged                  read the packaged app's state and desktop log instead of dev
  --channel <track>           packaged release track: ${PROBE_CHANNELS.join(", ")} (default stable)
  --state-dir <dir>           override the state directory
  --desktop-log <file>        override the desktop log (packaged default: <Electron userData>/logs/desktop-main.log)
  --label <text>              free text stored with the run
  --out <dir>                 run output directory (default: ${DEFAULT_OUT_DIR})
  --max-minutes <n>           finish automatically after n minutes`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseScenario(value: string | undefined): ProbeScenario {
  if (value === "streaming" || value === "tool") return value;
  return fail("--scenario must be streaming or tool");
}

function parseChannel(value: string | undefined): ProbeChannel {
  if (value === undefined) return "stable";
  if (isProbeChannel(value)) return value;
  return fail(`--channel must be one of ${PROBE_CHANNELS.join(", ")}`);
}

function parseMinutes(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) fail(`${flag} must be a positive number`);
  return minutes;
}

function printRow(row: SleepWakeRunRow): void {
  console.log(`\n${formatSummary(row)}\n`);
  console.log("JSON row:");
  console.log(JSON.stringify(row));
  console.log("\nTable row:");
  console.log(formatTableRow(row));
}

async function analyzeRun(runDir: string, finishedAtMs: number): Promise<SleepWakeRunRow> {
  const row = analyzeProbeRun(await collectProbeInputs(runDir, finishedAtMs));
  saveRow(runDir, row);
  return row;
}

function waitForFinish(maxMinutes: number | null): Promise<void> {
  return new Promise((resolve) => {
    const input = createInterface({ input: process.stdin });
    const done = () => {
      input.close();
      resolve();
    };
    input.once("line", done);
    process.once("SIGINT", done);
    if (maxMinutes !== null) setTimeout(done, maxMinutes * 60_000).unref();
  });
}

async function start(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenario: { type: "string" },
      "planned-sleep": { type: "string" },
      provider: { type: "string" },
      thread: { type: "string" },
      marker: { type: "string" },
      remote: { type: "boolean", default: false },
      packaged: { type: "boolean", default: false },
      channel: { type: "string" },
      "state-dir": { type: "string" },
      "desktop-log": { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      "max-minutes": { type: "string" },
    },
  });
  const build: ProbeBuild = values.packaged ? "packaged" : "dev";
  const channel: ProbeChannel = parseChannel(values.channel);
  const scenario = parseScenario(values.scenario);
  if (scenario === "tool" && !values.marker) {
    fail("--scenario tool needs --marker, or a rerun of the tool cannot be detected");
  }
  const stateDir = path.resolve(values["state-dir"] ?? defaultStateDir(build, channel));
  if (!existsSync(path.join(stateDir, "state.sqlite"))) fail(`no state.sqlite in ${stateDir}`);
  const topology: ProbeTopology = values.remote ? "ssh-remote" : "local";
  const startedAtMs = Date.now();
  const meta: ProbeRunMeta = {
    runId: `${new Date(startedAtMs).toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`,
    label: values.label ?? null,
    scenario,
    topology,
    plannedSleepMinutes: parseMinutes(values["planned-sleep"], "--planned-sleep"),
    build,
    stateDir,
    desktopLogPath: values["desktop-log"]
      ? path.resolve(values["desktop-log"])
      : defaultDesktopLogPath(build, channel),
    markerPath: values.marker ? path.resolve(values.marker) : null,
    threadId: values.thread ?? null,
    startedAtMs,
    startSequence: readMaxSequence(stateDir),
    platform: process.platform,
    osRelease: release(),
  };
  const runDir = createRunDir(path.resolve(values.out ?? DEFAULT_OUT_DIR), meta);
  if (values.provider) {
    writeProviderVersion(
      runDir,
      detectProviderVersion({
        provider: values.provider,
        stateDir,
        repoRoot: REPO_ROOT,
        providerLog: null,
      }),
    );
  }

  const sampleClock = () =>
    appendNdjson(runDir, RUN_FILES.clock, { wallMs: Date.now(), monoMs: performance.now() });
  // Runs on a timer during the sleep: a failed sample must never end the probe.
  const sampleTrace = () => {
    try {
      const sample = sampleTraceOffset(stateDir);
      if (sample !== null) appendNdjson(runDir, RUN_FILES.traceOffsets, sample);
    } catch (error) {
      console.error(`trace offset sample skipped: ${String(error)}`);
    }
  };
  sampleClock();
  sampleTrace();
  const clockTimer = setInterval(sampleClock, CLOCK_SAMPLE_INTERVAL_MS);
  const traceTimer = setInterval(sampleTrace, TRACE_OFFSET_SAMPLE_INTERVAL_MS);

  console.log(`Run ${meta.runId} started. Reading ${stateDir} (read-only).`);
  console.log(`Run files: ${runDir}`);
  if (topology === "ssh-remote" && meta.markerPath !== null) {
    console.log(
      "Remote run: use a fresh, empty marker file on the remote host for every run. Its times come from the remote clock, so every line in it is counted.",
    );
  }
  console.log("1. Start the turn in bigbud now.");
  console.log(
    meta.scenario === "tool"
      ? "2. As soon as the command shows as running, close the lid."
      : "2. As soon as the reply starts streaming, close the lid.",
  );
  console.log(`3. Keep it closed for ${meta.plannedSleepMinutes ?? "N"} minutes, then open it.`);
  console.log("4. Wait until the turn settles or 2 minutes pass, then press Enter here.");

  await waitForFinish(parseMinutes(values["max-minutes"], "--max-minutes"));
  sampleClock();
  sampleTrace();
  clearInterval(clockTimer);
  clearInterval(traceTimer);
  printRow(await analyzeRun(runDir, Date.now()));
  console.log(`\nAppended to ${path.join(path.dirname(runDir), RESULTS_FILE)}`);
}

function table(file: string | undefined): void {
  const resultsPath = path.resolve(file ?? path.join(DEFAULT_OUT_DIR, RESULTS_FILE));
  if (!existsSync(resultsPath)) fail(`no results at ${resultsPath}`);
  // A re-analysed run appends a newer row; keep the latest per run.
  const rows = new Map<string, SleepWakeRunRow>();
  for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as SleepWakeRunRow;
    rows.delete(row.runId);
    rows.set(row.runId, row);
  }
  console.log(formatTableHeader());
  for (const row of rows.values()) console.log(formatTableRow(row));
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "start":
    await start(rest);
    process.exit(0);
    break;
  case "analyze": {
    const runDir = rest[0] ? path.resolve(rest[0]) : fail("analyze needs a run directory");
    printRow(await analyzeRun(runDir, Date.now()));
    break;
  }
  case "table":
    table(rest[0]);
    break;
  default:
    fail(command === undefined ? "missing command" : `unknown command ${command}`);
}
