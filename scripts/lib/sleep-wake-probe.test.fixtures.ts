import type {
  ClockSample,
  MarkerLine,
  OrchestrationEventRow,
  ProbeInputs,
  ProbeScenario,
  ProbeTopology,
  ProviderLogLine,
  TraceSpan,
} from "./sleep-wake-probe.types.ts";

/** A recorded-shape run: probe starts, the lid closes a minute later for 10 minutes. */
export const START = Date.parse("2026-10-22T08:00:00.000Z");
export const SLEPT_AT = START + 60_000;
export const WOKE_AT = SLEPT_AT + 600_000;
export const THREAD = "thread-under-test";
export const TURN = "turn-under-test";

/** The server's span clock is 2 s behind wall time before the sleep. */
const PRE_OFFSET_MS = 2_000;
const MONO_ACROSS_SLEEP_MS = 1_000;
const DRIFT_MS = WOKE_AT - SLEPT_AT - MONO_ACROSS_SLEEP_MS;

/**
 * One sample a second, a 10-minute jump, then 200 s awake. On macOS the monotonic clock
 * barely moves across the jump; with `countsSleep` (Windows) it moves as much as the wall.
 */
export function clockAcrossSleep(options: {
  readonly countsSleep: boolean;
  readonly darkWakeAt?: number;
}): ClockSample[] {
  const samples: ClockSample[] = [];
  for (let wall = START; wall <= SLEPT_AT; wall += 1_000) {
    samples.push({ wallMs: wall, monoMs: wall - START });
  }
  let mono = SLEPT_AT - START;
  if (options.darkWakeAt !== undefined) {
    for (let step = 0; step < 3; step += 1) {
      mono += options.countsSleep ? 0 : 500;
      const wallMs = options.darkWakeAt + step * 1_000;
      samples.push({ wallMs, monoMs: options.countsSleep ? wallMs - START : mono });
    }
  }
  mono = options.countsSleep ? WOKE_AT - START : mono + MONO_ACROSS_SLEEP_MS;
  for (let wall = WOKE_AT; wall <= WOKE_AT + 200_000; wall += 1_000) {
    samples.push({ wallMs: wall, monoMs: mono + (wall - WOKE_AT) });
  }
  return samples;
}

/** Converts a wall time to the trace time the server would have written. */
function toTrace(wallMs: number): number {
  return wallMs - PRE_OFFSET_MS - (wallMs >= WOKE_AT ? DRIFT_MS : 0);
}

function span(
  name: string,
  wallStart: number,
  wallEnd: number,
  attributes: Record<string, unknown>,
): TraceSpan {
  return { name, startMs: toTrace(wallStart), endMs: toTrace(wallEnd), attributes };
}

const SPANS: TraceSpan[] = [
  // The socket opened before the sleep and the server saw it close 2 s after wake.
  span("http.server GET", START + 2_000, WOKE_AT + 2_000, { "http.route": "/ws" }),
  span("ws.connection.diagnostics", WOKE_AT + 1_500, WOKE_AT + 1_510, {
    "connection.trigger": "heartbeat-failure",
    "connection.occurred_at": new Date(WOKE_AT + 1_000).toISOString(),
  }),
  span("ws.connection.diagnostics", WOKE_AT + 3_200, WOKE_AT + 3_210, {
    "connection.trigger": "reconnect-success",
    "connection.occurred_at": new Date(WOKE_AT + 3_000).toISOString(),
  }),
];

export function event(
  sequence: number,
  eventType: string,
  occurredAtMs: number,
  payload: Record<string, unknown>,
): OrchestrationEventRow {
  return {
    sequence,
    eventType,
    streamId: THREAD,
    occurredAtMs,
    payload: { threadId: THREAD, ...payload },
  };
}

export function makeInputs(overrides: {
  readonly events: ReadonlyArray<OrchestrationEventRow>;
  readonly scenario?: ProbeScenario;
  readonly marker?: ReadonlyArray<MarkerLine>;
  readonly providerLog?: ReadonlyArray<ProviderLogLine>;
  readonly finishedAtMs?: number;
  readonly topology?: ProbeTopology;
  readonly clock?: ReadonlyArray<ClockSample>;
}): ProbeInputs {
  return {
    meta: {
      runId: "run-1",
      label: null,
      scenario: overrides.scenario ?? "streaming",
      topology: overrides.topology ?? "local",
      plannedSleepMinutes: 10,
      build: "packaged",
      stateDir: "/tmp/bigbud-state",
      desktopLogPath: "/tmp/bigbud-state/logs/desktop-main.log",
      markerPath: overrides.marker === undefined ? null : "/tmp/marker.log",
      threadId: null,
      startedAtMs: START,
      startSequence: 0,
      platform: "darwin",
      osRelease: "25.0.0",
    },
    finishedAtMs: overrides.finishedAtMs ?? WOKE_AT + 60_000,
    clock: overrides.clock ?? clockAcrossSleep({ countsSleep: false }),
    traceOffsets: [{ wallMs: START + 5_000, traceMs: toTrace(START + 5_000) }],
    spans: SPANS,
    signals: [
      { kind: "suspend", atMs: SLEPT_AT + 100, source: "desktop-log" },
      { kind: "os-sleep", atMs: SLEPT_AT + 300, source: "os-log" },
      { kind: "os-wake", atMs: WOKE_AT - 200, source: "os-log" },
      { kind: "resume", atMs: WOKE_AT + 500, source: "desktop-log" },
      { kind: "online", atMs: WOKE_AT + 800, source: "desktop-log" },
    ],
    events: overrides.events,
    providerLog: overrides.providerLog ?? [],
    marker: overrides.marker ?? null,
    providerVersion: { provider: "claudeAgent", version: "sdk 0.3.301", source: "fixture" },
    unavailable: [],
  };
}
