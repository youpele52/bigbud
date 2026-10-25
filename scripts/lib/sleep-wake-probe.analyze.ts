import {
  detectSleepWindow,
  makeTraceClock,
  sleepDriftMs,
  TRACE_OFFSET_MISMATCH_NOTE_MS,
} from "./sleep-wake-probe.clock.ts";
import { isWebSocketUpgradeSpan } from "./sleep-wake-probe.parse.ts";
import { analyzeTurn, selectTurn } from "./sleep-wake-probe.turn.ts";
import {
  SLEEP_WAKE_ROW_SCHEMA,
  type PowerSignal,
  type PowerSignalKind,
  type ProbeInputs,
  type SleepWakeRunRow,
  type SleepWindow,
  type TraceSpan,
} from "./sleep-wake-probe.types.ts";

/** Signals and spans this long before the sleep still belong to it. */
const PRE_SLEEP_SLACK_MS = 60_000;

function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function after(ms: number | null | undefined, wokeAtMs: number | null): number | null {
  return ms === null || ms === undefined || wokeAtMs === null ? null : Math.round(ms - wokeAtMs);
}

function firstSignal(
  signals: ReadonlyArray<PowerSignal>,
  kind: PowerSignalKind,
  fromMs: number,
): PowerSignal | undefined {
  return signals
    .filter((signal) => signal.kind === kind && signal.atMs >= fromMs)
    .toSorted((left, right) => left.atMs - right.atMs)[0];
}

/** Matches OS sleep and wake log entries to the probe's sleep, else the first pair in the run. */
function osWindow(
  signals: ReadonlyArray<PowerSignal>,
  window: SleepWindow | null,
  inputs: ProbeInputs,
) {
  const from = window === null ? inputs.meta.startedAtMs : window.sleptAtMs - PRE_SLEEP_SLACK_MS;
  const to = window === null ? inputs.finishedAtMs : window.wokeAtMs;
  const sleep = signals
    .filter((signal) => signal.kind === "os-sleep" && signal.atMs >= from && signal.atMs <= to)
    .toSorted((left, right) => left.atMs - right.atMs)[0];
  const wakes = signals
    .filter(
      (signal) =>
        signal.kind === "os-wake" &&
        sleep !== undefined &&
        signal.atMs >= sleep.atMs &&
        signal.atMs <=
          (window === null ? inputs.finishedAtMs : window.wokeAtMs + PRE_SLEEP_SLACK_MS),
    )
    .toSorted((left, right) => left.atMs - right.atMs);
  // With a probe window the full wake is the last one before the lid opened; else the first.
  const wake = window === null ? wakes[0] : wakes.at(-1);
  return { osSleepAt: iso(sleep?.atMs), osWakeAt: iso(wake?.atMs) };
}

function signalSection(
  signals: ReadonlyArray<PowerSignal>,
  window: SleepWindow | null,
  startedAtMs: number,
  finishedAtMs: number,
): SleepWakeRunRow["signals"] {
  // Older lines in the same log belong to earlier runs.
  const desktop = signals.filter(
    (signal) => signal.source === "desktop-log" && signal.atMs <= finishedAtMs,
  );
  if (desktop.length === 0) {
    return {
      source: "unavailable",
      suspendAt: null,
      resumeAt: null,
      onlineAt: null,
      offlineAt: null,
      resumeAfterWakeMs: null,
    };
  }
  const from = window === null ? startedAtMs : window.sleptAtMs - PRE_SLEEP_SLACK_MS;
  const resume = firstSignal(desktop, "resume", from);
  return {
    source: "desktop-log",
    suspendAt: iso(firstSignal(desktop, "suspend", from)?.atMs),
    resumeAt: iso(resume?.atMs),
    onlineAt: iso(firstSignal(desktop, "online", from)?.atMs),
    offlineAt: iso(firstSignal(desktop, "offline", from)?.atMs),
    resumeAfterWakeMs: after(resume?.atMs, window?.wokeAtMs ?? null),
  };
}

interface WallSpan extends TraceSpan {
  readonly wallStartMs: number;
  readonly wallEndMs: number;
}

/** A renderer report's own wall time, falling back to when the server traced it. */
function reportAt(span: WallSpan): number {
  const occurredAt = span.attributes["connection.occurred_at"];
  const parsed = typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
  return Number.isNaN(parsed) ? span.wallStartMs : parsed;
}

function reconnectSection(
  spans: ReadonlyArray<WallSpan>,
  window: SleepWindow | null,
): SleepWakeRunRow["reconnect"] {
  const wokeAtMs = window?.wokeAtMs ?? null;
  const reports = (trigger: string) =>
    spans.filter(
      (span) =>
        span.name === "ws.connection.diagnostics" &&
        span.attributes["connection.trigger"] === trigger,
    );
  const success = reports("reconnect-success")
    .map(reportAt)
    .filter((at) => wokeAtMs === null || at >= wokeAtMs)
    .toSorted((left, right) => left - right)[0];
  const oldSocketEnd = spans
    .filter(
      (span) =>
        isWebSocketUpgradeSpan(span) &&
        window !== null &&
        span.wallStartMs <= window.sleptAtMs &&
        span.wallEndMs >= window.wokeAtMs,
    )
    .map((span) => span.wallEndMs)
    .toSorted((left, right) => left - right)[0];
  const stalls = spans.filter((span) => span.name === "server.stalled");
  const stallDurations = stalls
    .map((span) => Number(span.attributes["stall.duration_ms"]))
    .filter((value) => Number.isFinite(value));
  const closeReports = reports("close").length + reports("error").length;
  const heartbeatFailures = reports("heartbeat-failure").length;
  return {
    socketDropped: closeReports > 0 || heartbeatFailures > 0 || oldSocketEnd !== undefined,
    oldSocketEndedAfterWakeMs: after(oldSocketEnd, wokeAtMs),
    reconnectSuccessAfterWakeMs: after(success, wokeAtMs),
    closeReports,
    heartbeatFailures,
    stalls: stalls.length,
    maxStallMs: stallDurations.length === 0 ? null : Math.max(...stallDurations),
    suspectedSleepEvents: spans.filter((span) => span.name === "server.suspected_system_sleep")
      .length,
  };
}

/** Builds the JSON row for one run from inputs already read from disk. */
export function analyzeProbeRun(inputs: ProbeInputs): SleepWakeRunRow {
  const { meta } = inputs;
  const notes = [...inputs.unavailable];
  const window = detectSleepWindow(inputs.clock);
  if (window === null) notes.push("no sleep detected in the probe's clock samples");
  if (window !== null && meta.plannedSleepMinutes !== null) {
    const sleptMinutes = window.wallGapMs / 60_000;
    if (sleptMinutes < meta.plannedSleepMinutes * 0.8) {
      notes.push(
        `slept ${sleptMinutes.toFixed(1)} min, under the planned ${meta.plannedSleepMinutes} min`,
      );
    }
  }
  if (window !== null && window.darkWakes > 0) {
    notes.push(`${window.darkWakes} dark wake(s) merged into the sleep window`);
  }

  const clock = makeTraceClock(inputs.traceOffsets, window);
  if (clock.preOffsetMs === null && inputs.spans.length > 0) {
    notes.push("trace offset unknown; trace times used uncorrected");
  }
  if (
    clock.postOffsetErrorMs !== null &&
    Math.abs(clock.postOffsetErrorMs) > TRACE_OFFSET_MISMATCH_NOTE_MS
  ) {
    notes.push(`trace clock correction off by ${clock.postOffsetErrorMs} ms after wake`);
  }
  const lowerBound = meta.startedAtMs - PRE_SLEEP_SLACK_MS;
  const spans: WallSpan[] = inputs.spans
    .map((span) => ({
      ...span,
      wallStartMs: clock.toWall(span.startMs),
      wallEndMs: clock.toWall(span.endMs),
    }))
    .filter((span) => span.wallEndMs >= lowerBound && span.wallStartMs <= inputs.finishedAtMs);

  const selection = selectTurn(inputs.events, meta.threadId);
  const turn = analyzeTurn({
    events: inputs.events,
    threadId: selection.threadId,
    window,
    providerLog: inputs.providerLog,
    marker: inputs.marker,
    startedAtMs: meta.startedAtMs,
    finishedAtMs: inputs.finishedAtMs,
    // The remote host's clock may differ from this one; the README asks for a fresh marker.
    filterMarkerByTime: meta.topology === "local",
  });
  if (turn.turn.outcome === "finished-before-sleep") {
    notes.push("the turn finished before the lid closed; this run does not count");
  }
  if (turn.turn.outcome === "no-turn") {
    notes.push(
      meta.threadId === null
        ? "no turn started after the probe did; start the probe first, or pass --thread"
        : `no turn started in thread ${meta.threadId} after the probe did; check the --thread ID`,
    );
  }
  if (turn.turn.outcome === "still-running") {
    notes.push("the turn was still progressing; finish the probe later or re-run analyze");
  }
  if (meta.topology === "ssh-remote" && turn.tools.markerStarts !== null) {
    notes.push("remote marker counted without a time filter; it must be a fresh file for this run");
  }
  if (meta.scenario === "tool" && turn.tools.markerStarts === 0) {
    notes.push("the marker file has no start line from this run; the tool did not run");
  }

  return {
    schema: SLEEP_WAKE_ROW_SCHEMA,
    runId: meta.runId,
    label: meta.label,
    recordedAt: new Date(inputs.finishedAtMs).toISOString(),
    platform: meta.platform,
    osRelease: meta.osRelease,
    build: meta.build,
    topology: meta.topology,
    scenario: meta.scenario,
    plannedSleepMinutes: meta.plannedSleepMinutes,
    provider: selection.provider ?? inputs.providerVersion?.provider ?? null,
    providerVersion: inputs.providerVersion?.version ?? null,
    providerVersionSource: inputs.providerVersion?.source ?? null,
    model: selection.model,
    threadId: selection.threadId,
    turnId: turn.turnId,
    sleep: {
      detected: window !== null,
      sleptAt: iso(window?.sleptAtMs),
      wokeAt: iso(window?.wokeAtMs),
      wallGapMs: window?.wallGapMs ?? null,
      monotonicGapMs: window === null ? null : Math.round(window.monotonicGapMs),
      darkWakes: window?.darkWakes ?? null,
      serverClockDriftMs: window === null ? null : Math.round(sleepDriftMs(window)),
      ...osWindow(inputs.signals, window, inputs),
    },
    signals: signalSection(inputs.signals, window, meta.startedAtMs, inputs.finishedAtMs),
    reconnect: reconnectSection(spans, window),
    turn: turn.turn,
    tools: turn.tools,
    notes,
  };
}
