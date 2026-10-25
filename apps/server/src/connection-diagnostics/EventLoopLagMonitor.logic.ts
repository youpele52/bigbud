import type {
  ServerEventLoopWindow,
  ServerStalledPayload,
} from "@bigbud/contracts/server/connectionDiagnostics.ts";
import {
  SERVER_STALL_MAX_SPANS,
  SERVER_STALL_THRESHOLD_MS,
} from "@bigbud/contracts/constants/connectionDiagnostics.constant.ts";

import type { SpanActivityEntry } from "../observability/SpanActivity.ts";

/** How often the drift sampler expects to run. Small enough to time a 1 s stall well. */
export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 250;
/** Width of one event-loop delay window written to the trace. */
export const EVENT_LOOP_WINDOW_MS = 10_000;
/** `monitorEventLoopDelay` sampling resolution. */
export const EVENT_LOOP_HISTOGRAM_RESOLUTION_MS = 20;

const RPC_SPAN_PREFIX = "ws.rpc.";

/**
 * Below this, a gap is never treated as system sleep. Real stalls this long
 * happen (75 s SSH unlock, 94 s queries), so length alone is not enough.
 */
export const SYSTEM_SLEEP_MIN_GAP_MS = 30_000;
/** A sleeping machine runs no process code; a busy event loop burns CPU. */
export const SYSTEM_SLEEP_MAX_CPU_RATIO = 0.05;
/** How far the wall and monotonic gaps may disagree and still count as the same gap. */
export const LOOP_CLOCK_AGREEMENT_TOLERANCE_MS = 2_000;

/** One reading of the clocks the sampler compares between ticks. */
export interface LoopClockReading {
  readonly monotonicMs: number;
  readonly wallMs: number;
  /** Process user plus system CPU time. */
  readonly cpuMs: number;
  /**
   * Linux only: time since boot including suspend (`os.uptime()`, CLOCK_BOOTTIME), in ms.
   * Unlike the wall clock it never steps, so it separates a suspend from a clock change.
   */
  readonly boottimeMs?: number;
}

/** How a platform's clocks behave across system sleep. */
export interface LoopSleepClock {
  /** The monotonic clock (`performance.now()`) keeps counting through sleep. */
  readonly monotonicIncludesSleep: boolean;
  /** The monotonic clock stops during sleep and `boottimeMs` counts it. */
  readonly boottimeCountsSleep: boolean;
}

/**
 * Node's `performance.now()` uses libuv's `uv_hrtime`. On macOS that is
 * `mach_continuous_time`, which counts sleep; on Windows `QueryPerformanceCounter` also counts
 * it. On Linux it is CLOCK_MONOTONIC, which stops during suspend, while `os.uptime()`
 * (CLOCK_BOOTTIME) keeps counting.
 */
export function loopSleepClockForPlatform(platform: NodeJS.Platform): LoopSleepClock {
  return {
    monotonicIncludesSleep: platform === "darwin" || platform === "win32",
    boottimeCountsSleep: platform === "linux",
  };
}

export type LoopGap =
  | {
      readonly kind: "stall";
      /** Monotonic time at which the sampler should have run, i.e. the latest the stall can have begun. */
      readonly startedAtMonotonicMs: number;
      readonly durationMs: number;
    }
  | { readonly kind: "system-sleep"; readonly durationMs: number };

/**
 * The sampler sleeps `intervalMs` between ticks. Any extra monotonic time is
 * time the event loop could not run it.
 *
 * On macOS and Windows the monotonic clock keeps counting through system sleep,
 * so the wall and monotonic clocks advance together across a sleep. There a
 * long gap during which the process used almost no CPU is classified as system
 * sleep instead of a stall. A synchronous wait that burns no CPU, such as a
 * long `spawnSync`, can also match this.
 *
 * On Linux the monotonic clock stops during suspend, so a sleep never looks
 * like a stall. Boot time (`boottimeMs`) keeps counting, so boot time running
 * ahead of monotonic time by at least `SYSTEM_SLEEP_MIN_GAP_MS` is the
 * suspended time. A wall-clock step changes neither clock, so it never looks
 * like a sleep.
 */
export function classifyLoopGap(input: {
  readonly previous: LoopClockReading;
  readonly now: LoopClockReading;
  readonly intervalMs?: number;
  readonly thresholdMs?: number;
  /** True where the monotonic clock counts system sleep (macOS and Windows). */
  readonly monotonicIncludesSleep?: boolean;
  /** True where the monotonic clock stops during sleep and `boottimeMs` counts it (Linux). */
  readonly boottimeCountsSleep?: boolean;
}): LoopGap | null {
  const intervalMs = input.intervalMs ?? EVENT_LOOP_SAMPLE_INTERVAL_MS;
  const thresholdMs = input.thresholdMs ?? SERVER_STALL_THRESHOLD_MS;
  const monotonicGapMs = input.now.monotonicMs - input.previous.monotonicMs;
  if (
    input.boottimeCountsSleep === true &&
    input.now.boottimeMs !== undefined &&
    input.previous.boottimeMs !== undefined
  ) {
    const suspendedMs = input.now.boottimeMs - input.previous.boottimeMs - monotonicGapMs;
    if (Number.isFinite(suspendedMs) && suspendedMs >= SYSTEM_SLEEP_MIN_GAP_MS) {
      return { kind: "system-sleep", durationMs: suspendedMs };
    }
  }
  const expectedTickMs = input.previous.monotonicMs + intervalMs;
  const durationMs = monotonicGapMs - intervalMs;
  if (!Number.isFinite(durationMs) || durationMs < thresholdMs) return null;
  if (input.monotonicIncludesSleep === true && durationMs >= SYSTEM_SLEEP_MIN_GAP_MS) {
    const wallGapMs = input.now.wallMs - input.previous.wallMs;
    const cpuMs = input.now.cpuMs - input.previous.cpuMs;
    const clocksAgree = Math.abs(wallGapMs - monotonicGapMs) <= LOOP_CLOCK_AGREEMENT_TOLERANCE_MS;
    if (clocksAgree && cpuMs >= 0 && cpuMs < monotonicGapMs * SYSTEM_SLEEP_MAX_CPU_RATIO) {
      return { kind: "system-sleep", durationMs };
    }
  }
  return { kind: "stall", startedAtMonotonicMs: expectedTickMs, durationMs };
}

/** Builds the stall payload from wall-clock bounds and the ranked spans that overlapped it. */
export function buildStalledPayload(input: {
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly runningSpans: ReadonlyArray<SpanActivityEntry>;
}): ServerStalledPayload {
  const durationMs = Math.max(0, Math.round(input.durationMs));
  const startedAtMs = input.endedAtMs - durationMs;
  const spans = input.runningSpans.slice(0, SERVER_STALL_MAX_SPANS).map((span) => ({
    name: span.name,
    startedAt: new Date(span.startedAtMs).toISOString(),
    endedAt: span.endedAtMs === null ? null : new Date(span.endedAtMs).toISOString(),
  }));
  const inFlightRpcMethods = [
    ...new Set(
      input.runningSpans
        .filter((span) => span.name.startsWith(RPC_SPAN_PREFIX))
        .map((span) => span.name.slice(RPC_SPAN_PREFIX.length))
        .filter((method) => method.length > 0),
    ),
  ].slice(0, SERVER_STALL_MAX_SPANS);
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(input.endedAtMs).toISOString(),
    durationMs,
    spans,
    inFlightRpcMethods,
  };
}

export interface EventLoopHistogramReading {
  readonly percentile: (percentile: number) => number;
  readonly max: number;
}

const nanosToRoundedMillis = (nanos: number): number =>
  Number.isFinite(nanos) && nanos > 0 ? Math.round(nanos / 100_000) / 10 : 0;

/** Converts `monitorEventLoopDelay` nanoseconds into one window summary. */
export function summarizeEventLoopWindow(input: {
  readonly histogram: EventLoopHistogramReading;
  readonly endedAtMs: number;
  readonly windowMs: number;
  readonly stallCount: number;
}): ServerEventLoopWindow {
  return {
    endedAt: new Date(input.endedAtMs).toISOString(),
    windowMs: Math.max(0, Math.round(input.windowMs)),
    p50Ms: nanosToRoundedMillis(input.histogram.percentile(50)),
    p99Ms: nanosToRoundedMillis(input.histogram.percentile(99)),
    maxMs: nanosToRoundedMillis(input.histogram.max),
    stallCount: Math.max(0, input.stallCount),
  };
}

/** A window whose worst delay stays under this is healthy and not worth a trace span. */
export const EVENT_LOOP_WINDOW_RETAIN_MAX_MS = 100;
export const EVENT_LOOP_WINDOW_RETAIN_P99_MS = 50;

/** Keeps the trace file for windows that show lag; healthy windows stay in memory only. */
export function shouldRetainEventLoopWindow(window: ServerEventLoopWindow): boolean {
  return (
    window.maxMs > EVENT_LOOP_WINDOW_RETAIN_MAX_MS ||
    window.p99Ms > EVENT_LOOP_WINDOW_RETAIN_P99_MS ||
    window.stallCount > 0
  );
}
