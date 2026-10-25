import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  detectProviderVersion,
  readDesktopSignals,
  readEventsSince,
  readMarker,
  readOsPowerSignals,
  readProviderLog,
  readTraceSpans,
} from "./sleep-wake-probe.sources.ts";
import { selectTurn } from "./sleep-wake-probe.turn.ts";
import type {
  ClockSample,
  PowerSignal,
  ProbeInputs,
  ProbeRunMeta,
  ProviderVersionInfo,
  TraceOffsetSample,
} from "./sleep-wake-probe.types.ts";

/**
 * A run directory holds everything `analyze` needs besides the live sources:
 * `meta.json`, `clock.ndjson`, `trace-offsets.ndjson`, `provider-version.json` and,
 * once analysed, `row.json`. Results from every run are appended to `results.ndjson`
 * one level up.
 */
export const RUN_FILES = {
  meta: "meta.json",
  clock: "clock.ndjson",
  traceOffsets: "trace-offsets.ndjson",
  providerVersion: "provider-version.json",
  row: "row.json",
} as const;

export const RESULTS_FILE = "results.ndjson";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Logs read from this long before the run started, for the pre-sleep trace offset. */
const SOURCE_LOOKBACK_MS = 10 * 60_000;

export function createRunDir(outDir: string, meta: ProbeRunMeta): string {
  const runDir = path.join(outDir, meta.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, RUN_FILES.meta), `${JSON.stringify(meta, null, 2)}\n`);
  return runDir;
}

export function appendNdjson(runDir: string, file: string, value: unknown): void {
  appendFileSync(path.join(runDir, file), `${JSON.stringify(value)}\n`);
}

function readNdjson<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function readRunMeta(runDir: string): ProbeRunMeta {
  return JSON.parse(readFileSync(path.join(runDir, RUN_FILES.meta), "utf8")) as ProbeRunMeta;
}

export function writeProviderVersion(runDir: string, info: ProviderVersionInfo): void {
  writeFileSync(path.join(runDir, RUN_FILES.providerVersion), `${JSON.stringify(info)}\n`);
}

function readProviderVersion(runDir: string): ProviderVersionInfo | null {
  const filePath = path.join(runDir, RUN_FILES.providerVersion);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8")) as ProviderVersionInfo;
}

/** Reads every source for one run, read-only, and records which ones were missing. */
export async function collectProbeInputs(
  runDir: string,
  finishedAtMs: number,
): Promise<ProbeInputs> {
  const meta = readRunMeta(runDir);
  const unavailable: string[] = [];
  const sinceMs = meta.startedAtMs - SOURCE_LOOKBACK_MS;

  const events = readEventsSince(meta.stateDir, meta.startSequence);
  const spans = await readTraceSpans(meta.stateDir, sinceMs).catch((error: unknown) => {
    unavailable.push(`trace unreadable: ${String(error)}`);
    return [];
  });

  const signals: PowerSignal[] = [];
  const desktop =
    meta.desktopLogPath === null ? null : await readDesktopSignals(meta.desktopLogPath, sinceMs);
  if (desktop !== null) {
    signals.push(...desktop);
    const inRun = desktop.filter(
      (signal) => signal.atMs >= meta.startedAtMs && signal.atMs <= finishedAtMs,
    );
    if (inRun.length === 0) {
      unavailable.push(
        `no connectivity signal lines inside the run in ${meta.desktopLogPath}; the installed build may predate 13b90621ba, else check --desktop-log or --channel`,
      );
    }
  } else {
    unavailable.push(
      meta.build === "dev"
        ? "desktop suspend/resume signals are not logged in dev (desktop log sink is packaged-only)"
        : `desktop log not found or not written during the run at ${meta.desktopLogPath ?? "(none)"}`,
    );
  }
  const os = readOsPowerSignals(meta.startedAtMs);
  signals.push(...os.signals);
  if (os.note !== null) unavailable.push(os.note);

  const selection = selectTurn(events, meta.threadId);
  const threadId = selection.threadId;
  const providerLog =
    threadId === null ? null : await readProviderLog(meta.stateDir, threadId, meta.startedAtMs);
  if (threadId !== null && providerLog === null) {
    unavailable.push(
      meta.build === "packaged"
        ? "no per-thread provider log (bigbud writes it in dev builds only)"
        : "no per-thread provider log",
    );
  }

  const marker = meta.markerPath === null ? null : readMarker(meta.markerPath);
  if (meta.markerPath !== null && marker === null) {
    unavailable.push(`marker file not found at ${meta.markerPath}`);
  }

  let providerVersion = readProviderVersion(runDir);
  if (providerVersion === null && selection.provider !== null) {
    providerVersion = detectProviderVersion({
      provider: selection.provider,
      stateDir: meta.stateDir,
      repoRoot: REPO_ROOT,
      providerLog,
    });
    writeProviderVersion(runDir, providerVersion);
  }
  if (meta.topology === "ssh-remote") {
    unavailable.push(
      "provider version is the local CLI; record the remote runtime's version by hand",
    );
  }

  return {
    meta,
    finishedAtMs,
    clock: readNdjson<ClockSample>(path.join(runDir, RUN_FILES.clock)),
    traceOffsets: readNdjson<TraceOffsetSample>(path.join(runDir, RUN_FILES.traceOffsets)),
    spans,
    signals,
    events,
    providerLog: providerLog ?? [],
    marker,
    providerVersion,
    unavailable,
  };
}

export function saveRow(runDir: string, row: unknown): void {
  writeFileSync(path.join(runDir, RUN_FILES.row), `${JSON.stringify(row, null, 2)}\n`);
  appendFileSync(path.join(path.dirname(runDir), RESULTS_FILE), `${JSON.stringify(row)}\n`);
}
