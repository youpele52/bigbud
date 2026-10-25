import type { ClockSample, SleepWindow, TraceOffsetSample } from "./sleep-wake-probe.types.ts";

/** Sampling period of the probe's own clocks. */
export const CLOCK_SAMPLE_INTERVAL_MS = 1_000;

/** Sampling period of the trace file's wall-to-trace offset. */
export const TRACE_OFFSET_SAMPLE_INTERVAL_MS = 5_000;

/** A wall-clock jump between two samples larger than this counts as a sleep. */
export const MIN_SLEEP_GAP_MS = 15_000;

/** Disagreement between the computed and the measured post-wake trace offset worth a note. */
export const TRACE_OFFSET_MISMATCH_NOTE_MS = 3_000;

/**
 * Gaps separated by less awake time than this are one sleep. macOS DarkWake (Power Nap)
 * and Windows modern standby give processes short slices while the lid stays closed.
 */
export const DARK_WAKE_MERGE_MS = 60_000;

/** Indexes `i` where samples `i - 1` to `i` jumped by at least `MIN_SLEEP_GAP_MS`. */
function gapEndIndexes(samples: ReadonlyArray<ClockSample>): number[] {
  const indexes: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index]!.wallMs - samples[index - 1]!.wallMs >= MIN_SLEEP_GAP_MS) {
      indexes.push(index);
    }
  }
  return indexes;
}

/**
 * Finds the longest sleep in the probe's clock samples, merging gaps split by brief dark
 * wakes. The wall gap alone marks the sleep. On Linux the monotonic clock stops during
 * sleep, so `wallGapMs - monotonicGapMs` is the time slept. On macOS (`mach_continuous_time`)
 * and Windows the monotonic clock keeps counting through sleep, so that difference stays near
 * zero there.
 */
export function detectSleepWindow(samples: ReadonlyArray<ClockSample>): SleepWindow | null {
  const gaps = gapEndIndexes(samples);
  if (gaps.length === 0) return null;
  // Group gaps whose awake time in between is short.
  const groups: number[][] = [[gaps[0]!]];
  for (const end of gaps.slice(1)) {
    const group = groups.at(-1)!;
    const previousEnd = group.at(-1)!;
    const awakeMs = samples[end - 1]!.wallMs - samples[previousEnd]!.wallMs;
    if (awakeMs < DARK_WAKE_MERGE_MS) group.push(end);
    else groups.push([end]);
  }
  let best: SleepWindow | null = null;
  for (const group of groups) {
    const first = samples[group[0]! - 1]!;
    const last = samples[group.at(-1)!]!;
    const window: SleepWindow = {
      sleptAtMs: first.wallMs,
      wokeAtMs: last.wallMs,
      wallGapMs: last.wallMs - first.wallMs,
      monotonicGapMs: Math.max(0, last.monoMs - first.monoMs),
      darkWakes: group.length - 1,
    };
    if (best === null || window.wallGapMs > best.wallGapMs) best = window;
  }
  return best;
}

/** How far the server's span clock fell behind the wall clock across the sleep. */
export function sleepDriftMs(window: SleepWindow | null): number {
  if (window === null) return 0;
  return Math.max(0, window.wallGapMs - window.monotonicGapMs);
}

function offsetOf(sample: TraceOffsetSample): number {
  return sample.wallMs - sample.traceMs;
}

export interface TraceClock {
  /** Converts a server span timestamp to wall time. */
  readonly toWall: (traceMs: number) => number;
  /** Offset before the sleep, or null when no sample was usable. */
  readonly preOffsetMs: number | null;
  /** Measured post-wake offset minus the computed one, when both exist. */
  readonly postOffsetErrorMs: number | null;
}

/**
 * Server span timestamps are process start time plus `process.hrtime`. Across a sleep
 * the server's hrtime advances exactly as much as the probe's monotonic clock, so a span
 * that started after the sleep is behind wall time by an extra `sleepDriftMs`. That drift is
 * the slept time on Linux and near zero on macOS and Windows, where hrtime counts sleep.
 * The pre-sleep offset comes from trace-file samples (file mtime against newest span end).
 */
export function makeTraceClock(
  samples: ReadonlyArray<TraceOffsetSample>,
  window: SleepWindow | null,
): TraceClock {
  const drift = sleepDriftMs(window);
  const pre =
    window === null ? samples : samples.filter((sample) => sample.wallMs <= window.sleptAtMs);
  const post = window === null ? [] : samples.filter((sample) => sample.wallMs >= window.wokeAtMs);
  const lastPre = pre.at(-1);
  const firstPost = post[0];
  const preOffsetMs =
    lastPre !== undefined
      ? offsetOf(lastPre)
      : firstPost !== undefined
        ? offsetOf(firstPost) - drift
        : null;
  const postOffsetErrorMs =
    lastPre !== undefined && firstPost !== undefined
      ? Math.round(offsetOf(firstPost) - (offsetOf(lastPre) + drift))
      : null;
  const base = preOffsetMs ?? 0;
  const sleptAtTraceMs = window === null ? Number.POSITIVE_INFINITY : window.sleptAtMs - base;
  return {
    toWall: (traceMs) => traceMs + base + (traceMs > sleptAtTraceMs ? drift : 0),
    preOffsetMs,
    postOffsetErrorMs,
  };
}
