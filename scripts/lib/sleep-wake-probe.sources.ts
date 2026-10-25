import { spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import {
  mightBeProbeSpan,
  parseDesktopSignalLine,
  parseJournalSuspendLine,
  parseMarkerLine,
  parsePmsetLine,
  parseProviderLogLine,
  parseTraceLine,
  parseVersionOutput,
  extractSdkVersion,
} from "./sleep-wake-probe.parse.ts";
import { traceFilePath } from "./sleep-wake-probe.paths.ts";
import type {
  MarkerLine,
  OrchestrationEventRow,
  PowerSignal,
  ProviderLogLine,
  ProviderVersionInfo,
  TraceOffsetSample,
  TraceSpan,
} from "./sleep-wake-probe.types.ts";

/** Upper bound on events read per run, so a busy database cannot exhaust memory. */
const MAX_EVENTS = 50_000;
/** Tail read from the trace file when sampling the wall-to-trace offset. */
const TRACE_TAIL_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;

function openReadOnly(stateDir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(stateDir, "state.sqlite"), { readOnly: true });
  db.exec("PRAGMA query_only = 1");
  return db;
}

export function readMaxSequence(stateDir: string): number {
  const db = openReadOnly(stateDir);
  try {
    const row = db.prepare("SELECT max(sequence) AS value FROM orchestration_events").get();
    return Number(row?.value ?? 0);
  } finally {
    db.close();
  }
}

/** Orchestration events committed after the probe started. Read-only; never writes. */
export function readEventsSince(stateDir: string, sequence: number): OrchestrationEventRow[] {
  const db = openReadOnly(stateDir);
  try {
    const rows = db
      .prepare(
        `SELECT sequence, event_type, stream_id, occurred_at, payload_json
         FROM orchestration_events WHERE sequence > ? ORDER BY sequence LIMIT ?`,
      )
      .all(sequence, MAX_EVENTS);
    return rows.map((row) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        payload = null;
      }
      return {
        sequence: Number(row.sequence),
        eventType: String(row.event_type),
        streamId: String(row.stream_id),
        occurredAtMs: Date.parse(String(row.occurred_at)),
        payload,
      };
    });
  } finally {
    db.close();
  }
}

async function readLines(filePath: string, onLine: (line: string) => void): Promise<void> {
  const lines = createInterface({ input: createReadStream(filePath, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) onLine(line);
}

/**
 * Files named `base` or `base.N` in `dir` modified since `sinceMs`. A file that rotates
 * away between listing and stat is skipped.
 */
async function rotatedFiles(dir: string, base: string, sinceMs: number): Promise<string[]> {
  const names = (await readdir(dir)).filter(
    (name) =>
      name === base || (name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1))),
  );
  const files: string[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      if (statSync(filePath).mtimeMs >= sinceMs) files.push(filePath);
    } catch {
      // Rotated or removed since the listing.
    }
  }
  return files;
}

/** Reads every line of a file, tolerating a rotation that removes it mid-read. */
async function readLinesTolerant(
  filePath: string,
  onLine: (line: string) => void,
): Promise<boolean> {
  try {
    await readLines(filePath, onLine);
    return true;
  } catch {
    return false;
  }
}

/** Probe spans from the trace file and its rotations modified since `sinceMs`. */
export async function readTraceSpans(stateDir: string, sinceMs: number): Promise<TraceSpan[]> {
  const spans: TraceSpan[] = [];
  const files = await rotatedFiles(path.join(stateDir, "logs"), "server.trace.ndjson", sinceMs);
  for (const filePath of files) {
    await readLinesTolerant(filePath, (line) => {
      if (!mightBeProbeSpan(line)) return;
      const span = parseTraceLine(line);
      if (span !== null) spans.push(span);
    });
  }
  return spans;
}

/**
 * Pairs the trace file's mtime (wall) with the newest span end in its tail (trace time).
 * Returns null instead of throwing when the file rotates mid-sample, because this runs
 * on a timer during the sleep.
 */
export function sampleTraceOffset(stateDir: string): TraceOffsetSample | null {
  const filePath = traceFilePath(stateDir);
  let buffer: Buffer;
  let mtimeMs: number;
  try {
    const stat = statSync(filePath);
    mtimeMs = stat.mtimeMs;
    const length = Math.min(stat.size, TRACE_TAIL_BYTES);
    buffer = Buffer.alloc(length);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buffer, 0, length, stat.size - length);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const line of buffer.toString("utf8").split("\n")) {
    const span = parseTraceLine(line);
    if (span !== null && (newest === null || span.endMs > newest)) newest = span.endMs;
  }
  return newest === null ? null : { wallMs: mtimeMs, traceMs: newest };
}

/** Connectivity lines from `desktop-main.log` and its rotations modified since `sinceMs`. */
export async function readDesktopSignals(
  logPath: string,
  sinceMs: number,
): Promise<PowerSignal[] | null> {
  let files: string[];
  try {
    files = await rotatedFiles(path.dirname(logPath), path.basename(logPath), sinceMs);
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const signals: PowerSignal[] = [];
  for (const filePath of files) {
    await readLinesTolerant(filePath, (line) => {
      const signal = parseDesktopSignalLine(line);
      if (signal !== null) signals.push(signal);
    });
  }
  return signals;
}

/** OS sleep and wake times: `pmset -g log` on macOS, kernel journal on Linux. */
export function readOsPowerSignals(sinceMs: number): {
  signals: PowerSignal[];
  note: string | null;
} {
  if (process.platform === "darwin") {
    const result = spawnSync("pmset", ["-g", "log"], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) return { signals: [], note: "pmset -g log failed" };
    const signals = result.stdout
      .split("\n")
      .map(parsePmsetLine)
      .filter((signal): signal is PowerSignal => signal !== null && signal.atMs >= sinceMs);
    return { signals, note: null };
  }
  if (process.platform === "linux") {
    const since = `@${Math.floor(sinceMs / 1000)}`;
    const result = spawnSync("journalctl", ["-k", "--since", since, "-o", "short-iso-precise"], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) return { signals: [], note: "journalctl -k unavailable" };
    const signals = result.stdout
      .split("\n")
      .map(parseJournalSuspendLine)
      .filter((signal): signal is PowerSignal => signal !== null);
    return { signals, note: null };
  }
  return { signals: [], note: `OS power log not read on ${process.platform}` };
}

export async function readProviderLog(
  stateDir: string,
  threadId: string,
  sinceMs: number,
): Promise<ProviderLogLine[] | null> {
  const filePath = path.join(stateDir, "logs", "provider", `${threadId}.log`);
  if (!existsSync(filePath)) return null;
  const lines: ProviderLogLine[] = [];
  await readLines(filePath, (line) => {
    const parsed = parseProviderLogLine(line);
    if (parsed !== null && parsed.atMs >= sinceMs) lines.push(parsed);
  });
  return lines;
}

export function readMarker(filePath: string): MarkerLine[] | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map(parseMarkerLine)
    .filter((line): line is MarkerLine => line !== null);
}

/** Default CLI per provider kind, matching `packages/contracts/src/core/settings.ts`. */
const PROVIDER_CLI: Readonly<Record<string, string>> = {
  codex: "codex",
  claudeAgent: "claude",
  copilot: "copilot",
  opencodeV2: "opencode",
  opencode: "opencode",
  kilocode: "kilo",
  pi: "pi",
  cursor: "agent",
  devin: "devin",
};

/** SDK packages the server embeds, read from the dev checkout's `apps/server`. */
const PROVIDER_SDK: Readonly<Record<string, string>> = {
  claudeAgent: "@anthropic-ai/claude-agent-sdk",
  copilot: "@github/copilot-sdk",
  opencodeV2: "@opencode-ai/sdk",
  kilocode: "@opencode-ai/sdk",
  pi: "@earendil-works/pi-coding-agent",
};

function configuredBinary(stateDir: string, provider: string): string | null {
  try {
    const settings: unknown = JSON.parse(
      readFileSync(path.join(stateDir, "settings.json"), "utf8"),
    );
    const value = (settings as { providers?: Record<string, { binaryPath?: unknown }> })
      .providers?.[provider]?.binaryPath;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function cliVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return parseVersionOutput(`${result.stdout}\n${result.stderr}`);
}

function sdkVersion(repoRoot: string, packageName: string): string | null {
  const manifest = path.join(
    repoRoot,
    "apps",
    "server",
    "node_modules",
    packageName,
    "package.json",
  );
  try {
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Local CLI `--version` plus the embedded SDK version. Run before the sleep. A remote
 * provider runtime's version cannot be read from here.
 */
export function detectProviderVersion(input: {
  readonly provider: string;
  readonly stateDir: string;
  readonly repoRoot: string;
  readonly providerLog: ReadonlyArray<ProviderLogLine> | null;
}): ProviderVersionInfo {
  const parts: string[] = [];
  const sources: string[] = [];
  const binary = configuredBinary(input.stateDir, input.provider) ?? PROVIDER_CLI[input.provider];
  const cli = binary === undefined ? null : cliVersion(binary);
  if (cli !== null) {
    parts.push(`cli ${cli}`);
    sources.push(`${binary} --version`);
  }
  const logged = input.providerLog === null ? null : extractSdkVersion(input.providerLog);
  const sdkPackage = PROVIDER_SDK[input.provider];
  const sdk = logged ?? (sdkPackage === undefined ? null : sdkVersion(input.repoRoot, sdkPackage));
  if (sdk !== null) {
    parts.push(`sdk ${sdk}`);
    sources.push(logged !== null ? "provider log sdkVersion" : `${sdkPackage} package.json`);
  }
  return {
    provider: input.provider,
    version: parts.length === 0 ? null : parts.join("; "),
    source: sources.length === 0 ? "unavailable" : sources.join(", "),
  };
}
