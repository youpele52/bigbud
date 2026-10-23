/**
 * Pure merging of sleep evidence into sleep epochs.
 *
 * Three sources report that the machine slept: Electron main's power hints (fd 5), the
 * server's own event-loop gap detector, and the Rust supervisor's suspended-time clock. Each
 * may miss a sleep or report it twice, so evidence from any source within
 * `SLEEP_EPOCH_MERGE_WINDOW_MS` of an existing epoch extends that epoch instead of opening a
 * new one.
 *
 * @module SystemSleepEpochs.logic
 */

export type SleepEvidenceSource = "desktop-hint" | "server-gap" | "supervisor-clock";

/** One source's report that the machine slept between `startedAtMs` and `endedAtMs`. */
export interface SleepEvidence {
  readonly source: SleepEvidenceSource;
  /** Estimated start; equal to `endedAtMs` when the start is unknown (a missed suspend). */
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

export interface SleepEpoch {
  readonly epochId: number;
  /** Estimated: sources see the start late or not at all. */
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly sources: ReadonlyArray<SleepEvidenceSource>;
}

/** Evidence within this distance of an epoch belongs to it. */
export const SLEEP_EPOCH_MERGE_WINDOW_MS = 60_000;
/** How many epochs are kept in memory. */
export const SLEEP_EPOCH_HISTORY_LIMIT = 32;
/** A failure this long before the estimated start may still be the sleep's doing. */
export const SLEEP_WINDOW_BEFORE_MS = 5_000;
/**
 * On macOS and Windows every pending timer, including provider and heartbeat timeouts, fires
 * right at wake, so failures observed this long after wake still belong to the sleep.
 */
export const SLEEP_WINDOW_AFTER_MS = 60_000;

export interface SleepEpochState {
  readonly nextEpochId: number;
  readonly epochs: ReadonlyArray<SleepEpoch>;
}

export const initialSleepEpochState: SleepEpochState = { nextEpochId: 1, epochs: [] };

export interface SleepEvidenceResult {
  readonly state: SleepEpochState;
  /** The epoch the evidence opened or extended. */
  readonly epoch: SleepEpoch;
  /** True when the evidence opened a new epoch; false when it merged into an existing one. */
  readonly opened: boolean;
}

function overlapsWithin(epoch: SleepEpoch, evidence: SleepEvidence): boolean {
  return (
    evidence.startedAtMs <= epoch.endedAtMs + SLEEP_EPOCH_MERGE_WINDOW_MS &&
    evidence.endedAtMs >= epoch.startedAtMs - SLEEP_EPOCH_MERGE_WINDOW_MS
  );
}

function toEpoch(
  epochId: number,
  startedAtMs: number,
  endedAtMs: number,
  sources: ReadonlyArray<SleepEvidenceSource>,
): SleepEpoch {
  return {
    epochId,
    startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    sources,
  };
}

/** Adds one piece of evidence: merges it into a nearby epoch, or opens a new one. */
export function addSleepEvidence(
  state: SleepEpochState,
  evidence: SleepEvidence,
): SleepEvidenceResult {
  const startedAtMs = Math.min(evidence.startedAtMs, evidence.endedAtMs);
  const normalized = { ...evidence, startedAtMs };
  const index = state.epochs.findLastIndex((epoch) => overlapsWithin(epoch, normalized));
  if (index >= 0) {
    const current = state.epochs[index]!;
    const merged = toEpoch(
      current.epochId,
      Math.min(current.startedAtMs, normalized.startedAtMs),
      Math.max(current.endedAtMs, normalized.endedAtMs),
      current.sources.includes(evidence.source)
        ? current.sources
        : [...current.sources, evidence.source],
    );
    const epochs = state.epochs.map((epoch, position) => (position === index ? merged : epoch));
    return { state: { ...state, epochs }, epoch: merged, opened: false };
  }
  const opened = toEpoch(state.nextEpochId, normalized.startedAtMs, normalized.endedAtMs, [
    evidence.source,
  ]);
  const epochs = [...state.epochs, opened]
    .toSorted((left, right) => left.endedAtMs - right.endedAtMs)
    .slice(-SLEEP_EPOCH_HISTORY_LIMIT);
  return { state: { nextEpochId: state.nextEpochId + 1, epochs }, epoch: opened, opened: true };
}

/** The epoch whose recovery window contains `atMs`, latest first. */
export function findSleepEpochAt(
  epochs: ReadonlyArray<SleepEpoch>,
  atMs: number,
): SleepEpoch | undefined {
  return epochs.findLast(
    (epoch) =>
      atMs >= epoch.startedAtMs - SLEEP_WINDOW_BEFORE_MS &&
      atMs <= epoch.endedAtMs + SLEEP_WINDOW_AFTER_MS,
  );
}

/** The most recently ended epoch. */
export function latestSleepEpoch(epochs: ReadonlyArray<SleepEpoch>): SleepEpoch | undefined {
  return epochs.reduce<SleepEpoch | undefined>(
    (latest, epoch) =>
      latest === undefined || epoch.endedAtMs > latest.endedAtMs ? epoch : latest,
    undefined,
  );
}
