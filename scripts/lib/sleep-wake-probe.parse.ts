import type {
  MarkerLine,
  PowerSignal,
  PowerSignalKind,
  ProviderLogLine,
  TraceSpan,
} from "./sleep-wake-probe.types.ts";

const NANOS_PER_MS = 1_000_000n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nanosToMs(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return Number(BigInt(value) / NANOS_PER_MS);
}

/** Parses one `server.trace.ndjson` line. Only effect spans carry the fields we use. */
export function parseTraceLine(line: string): TraceSpan | null {
  if (!line.startsWith("{")) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(record) || typeof record.name !== "string") return null;
  const startMs = nanosToMs(record.startTimeUnixNano);
  const endMs = nanosToMs(record.endTimeUnixNano);
  if (startMs === null || endMs === null) return null;
  return {
    name: record.name,
    startMs,
    endMs,
    attributes: isRecord(record.attributes) ? record.attributes : {},
  };
}

/** Span names the probe keeps; everything else in the trace is skipped while reading. */
export const PROBE_SPAN_NAMES: ReadonlySet<string> = new Set([
  "http.server GET",
  "ws.connection.diagnostics",
  "server.stalled",
  "server.suspected_system_sleep",
  "orchestration.delivery.session.ended",
]);

/** Cheap pre-filter so a 10 MB trace file is not fully JSON-parsed. */
export function mightBeProbeSpan(line: string): boolean {
  for (const name of PROBE_SPAN_NAMES) {
    if (line.includes(`"name":"${name}"`)) return true;
  }
  return false;
}

export function isWebSocketUpgradeSpan(span: TraceSpan): boolean {
  return span.name === "http.server GET" && span.attributes["http.route"] === "/ws";
}

const DESKTOP_SIGNAL_LINE =
  /^\[(?<at>[^\]]+)\] \[desktop[^\]]*\] connectivity signal kind=(?<kind>[a-z-]+) /;

const DESKTOP_SIGNAL_KINDS: ReadonlySet<string> = new Set([
  "suspend",
  "resume",
  "lock-screen",
  "unlock-screen",
  "online",
  "offline",
]);

/**
 * Parses a packaged `desktop-main.log` connectivity line, for example
 * `[2026-10-22T09:00:00.000Z] [desktop run=abc] connectivity signal kind=resume sequence=4`.
 */
export function parseDesktopSignalLine(line: string): PowerSignal | null {
  const match = DESKTOP_SIGNAL_LINE.exec(line);
  const kind = match?.groups?.kind;
  const atMs = Date.parse(match?.groups?.at ?? "");
  if (kind === undefined || !DESKTOP_SIGNAL_KINDS.has(kind) || Number.isNaN(atMs)) return null;
  return { kind: kind as PowerSignalKind, atMs, source: "desktop-log" };
}

const PMSET_LINE =
  /^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2}) (?<zone>[+-]\d{2})(?<zoneMin>\d{2}) (?<kind>Sleep|Wake|DarkWake)\s+\t/;

/**
 * Parses a macOS `pmset -g log` line. `Sleep` is the OS entering sleep and `Wake` a
 * full wake. The kind column is padded with spaces and ends in a tab, which keeps
 * `Wake Requests` lines (scheduled wakes, logged right after `Sleep`) out. `DarkWake` (Power Nap) is reported as neither, because the lid stays shut.
 */
export function parsePmsetLine(line: string): PowerSignal | null {
  const groups = PMSET_LINE.exec(line)?.groups;
  if (groups === undefined || groups.kind === "DarkWake") return null;
  const atMs = Date.parse(`${groups.date}T${groups.time}${groups.zone}:${groups.zoneMin}`);
  if (Number.isNaN(atMs)) return null;
  return { kind: groups.kind === "Sleep" ? "os-sleep" : "os-wake", atMs, source: "os-log" };
}

const JOURNAL_SUSPEND_LINE = /^(?<at>\d{4}-\d{2}-\d{2}T\S+)\s.*\bPM: suspend (?<edge>entry|exit)\b/;

/** Parses a Linux `journalctl -k -o short-iso-precise` kernel suspend line. */
export function parseJournalSuspendLine(line: string): PowerSignal | null {
  const groups = JOURNAL_SUSPEND_LINE.exec(line)?.groups;
  const atMs = Date.parse(groups?.at ?? "");
  if (groups === undefined || Number.isNaN(atMs)) return null;
  return { kind: groups.edge === "entry" ? "os-sleep" : "os-wake", atMs, source: "os-log" };
}

const PROVIDER_LOG_LINE = /^\[(?<at>[^\]]+)\] (?<channel>[A-Z]+): (?<text>.*)$/;

/** Parses a per-thread provider log line such as `[ISO] NTIVE: {...}` or `[ISO] CANON: {...}`. */
export function parseProviderLogLine(line: string): ProviderLogLine | null {
  const groups = PROVIDER_LOG_LINE.exec(line)?.groups;
  const atMs = Date.parse(groups?.at ?? "");
  if (groups === undefined || Number.isNaN(atMs)) return null;
  return { atMs, channel: groups.channel ?? "", text: groups.text ?? "" };
}

const SDK_VERSION = /"sdkVersion":"(?<version>[^"]+)"/;

/** Some adapters stamp native events with the SDK version (Claude does). */
export function extractSdkVersion(lines: ReadonlyArray<ProviderLogLine>): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const version = SDK_VERSION.exec(lines[index]!.text)?.groups?.version;
    if (version !== undefined) return version;
  }
  return null;
}

const MARKER_LINE = /^(?<kind>start|done) (?<epoch>\d{9,13})\s*$/;

/**
 * Parses the marker file the conformance tool command appends to:
 * `start <unix seconds>` before `sleep`, `done <unix seconds>` after it.
 */
export function parseMarkerLine(line: string): MarkerLine | null {
  const groups = MARKER_LINE.exec(line.trim())?.groups;
  if (groups === undefined) return null;
  const epoch = Number(groups.epoch);
  const atMs = groups.epoch!.length <= 10 ? epoch * 1000 : epoch;
  return { kind: groups.kind === "start" ? "start" : "done", atMs };
}

/** Extracts the first version-looking token from `--version` output. */
export function parseVersionOutput(output: string): string | null {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(output);
  return match?.[0] ?? null;
}
