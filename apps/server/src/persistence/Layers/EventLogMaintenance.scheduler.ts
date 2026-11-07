/**
 * Pure scheduling rules for event-log maintenance: adaptive batch sizes, load backoff,
 * guaranteed progress, tick cadence and the starved flag. No I/O, so every rule is unit-tested
 * with plain numbers.
 *
 * @module EventLogMaintenance.scheduler
 */
import type { EventLogMaintenanceTickMode } from "../Services/EventLogMaintenance.ts";

export const MAINTENANCE_BATCH = {
  /** Start small and grow: the first batches measure what a row costs on this database. */
  initial: 100,
  min: 100,
  max: 5_000,
  /** A batch should hold the single SQLite worker for at most this long. */
  targetMs: 50,
} as const;
/**
 * Pages one batch may write to the WAL. SQLite checkpoints inside the committing transaction
 * once the WAL holds 1,000 pages (`wal_autocheckpoint`), and copying random index pages into a
 * large file costs about 21 us a page: on the 8 GB log a 1,000-event batch dirtied ~3,900 pages
 * and its commit took ~150 ms. Staying under the threshold, with a PASSIVE checkpoint after
 * every batch, keeps that copy out of the batch and bounds the checkpoint itself.
 */
export const MAINTENANCE_MAX_BATCH_PAGES = 400;
/** Wall time one tick may spend running batches. */
export const MAINTENANCE_TICK_BUDGET_MS = 1_000;
export const MAINTENANCE_IDLE_INTERVAL_MS = 2 * 60_000;
export const MAINTENANCE_BACKLOG_INTERVAL_MS = 15_000;
/** While a backlog remains, one minimum batch runs at least this often, even under soft load. */
export const MAINTENANCE_GUARANTEED_PROGRESS_MS = 10 * 60_000;
/** Matches the baseline coordinator's cooldown. */
export const MAINTENANCE_FAILURE_BACKOFF_MS = 15 * 60_000;
export const MAINTENANCE_STARVED_AFTER_MS = 24 * 60 * 60_000;
export const MAINTENANCE_RATE_WINDOW_MS = 10 * 60_000;

export const MAINTENANCE_LOAD = {
  softQueueDepth: 4,
  hardQueueDepth: 16,
  eventLoopLagMs: 100,
  maxStreamingTurns: 2,
} as const;

/** Aim below the target so one slow statement does not push a batch over it. */
const TARGET_HEADROOM = 0.4;
const SAMPLE_WINDOW = 3;
/** Tiny batches are dominated by fixed per-statement cost and say little about per-row cost. */
const MIN_SAMPLE_ROWS = 50;

/**
 * Predictive batch size for one kind of batch. The next size comes from the worst per-row time
 * and per-row WAL pages of the last three batches, so a slow batch shrinks the following ones
 * before they run. Grows at most 2x after a full batch, never after a partial one, and stays
 * within [100, max] (5,000 unless the kind sets a lower cap).
 */
export class BatchSizer {
  constructor(private readonly max: number = MAINTENANCE_BATCH.max) {}

  private readonly samples: Array<{
    readonly msPerRow: number;
    readonly pagesPerRow: number | null;
  }> = [];
  size: number = MAINTENANCE_BATCH.initial;

  record(rows: number, elapsedMs: number, walPages: number | null): number {
    const requested = this.size;
    if (rows >= MIN_SAMPLE_ROWS || elapsedMs > MAINTENANCE_BATCH.targetMs) {
      const counted = Math.max(1, rows);
      this.samples.push({
        msPerRow: Math.max(0, elapsedMs) / counted,
        pagesPerRow: walPages === null || walPages < 0 ? null : walPages / counted,
      });
      if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();
    }
    const msPerRow = Math.max(0, ...this.samples.map((sample) => sample.msPerRow));
    const pagesPerRow = Math.max(0, ...this.samples.map((sample) => sample.pagesPerRow ?? 0));
    const byTime =
      msPerRow > 0 ? (MAINTENANCE_BATCH.targetMs * TARGET_HEADROOM) / msPerRow : Infinity;
    const byPages = pagesPerRow > 0 ? MAINTENANCE_MAX_BATCH_PAGES / pagesPerRow : Infinity;
    const growth = rows >= requested ? requested * 2 : requested;
    const next = Math.min(byTime, byPages, growth);
    this.size = Math.max(
      MAINTENANCE_BATCH.min,
      Math.min(this.max, Math.floor(Number.isFinite(next) ? next : growth)),
    );
    return this.size;
  }
}

export interface MaintenanceLoadSignals {
  /** Statements queued on the read-write SQLite worker. */
  readonly queueDepth: number;
  /** Event-loop lag over the last minute exceeded the threshold. */
  readonly eventLoopLagged: boolean;
  readonly streamingTurns: number;
  /** Other background maintenance ticks running SQL right now. */
  readonly backgroundActive: number;
  readonly batchInFlight: boolean;
  /** The one-time database rebuild (phase 4 `VACUUM`) holds the write connection. */
  readonly databaseCompactionRunning: boolean;
}

export interface TickDecisionInput {
  readonly nowMs: number;
  readonly signals: MaintenanceLoadSignals;
  readonly backlog: number;
  /** Last batch, or when maintenance started if none has run yet. */
  readonly lastProgressAtMs: number;
  readonly backoffUntilMs: number | null;
}

export function decideTick(input: TickDecisionInput): {
  readonly mode: EventLogMaintenanceTickMode;
  readonly reason: string;
} {
  const { signals } = input;
  if (signals.batchInFlight) return { mode: "skip-hard", reason: "batch-in-flight" };
  if (signals.databaseCompactionRunning)
    return { mode: "skip-hard", reason: "database-compaction-running" };
  if (signals.queueDepth > MAINTENANCE_LOAD.hardQueueDepth)
    return { mode: "skip-hard", reason: "worker-queue-hard" };
  if (input.backoffUntilMs !== null && input.nowMs < input.backoffUntilMs)
    return { mode: "backoff", reason: "failure-backoff" };
  const soft =
    signals.queueDepth > MAINTENANCE_LOAD.softQueueDepth
      ? "worker-queue"
      : signals.eventLoopLagged
        ? "event-loop-lag"
        : signals.streamingTurns > MAINTENANCE_LOAD.maxStreamingTurns
          ? "streaming-turns"
          : signals.backgroundActive > 0
            ? "background-maintenance"
            : null;
  if (soft === null) return { mode: "full", reason: "idle" };
  if (
    input.backlog > 0 &&
    input.nowMs - input.lastProgressAtMs >= MAINTENANCE_GUARANTEED_PROGRESS_MS
  ) {
    return { mode: "minimum", reason: `guaranteed-progress:${soft}` };
  }
  return { mode: "skip-soft", reason: soft };
}

export function nextTickDelayMs(backlog: number): number {
  return backlog > 0 ? MAINTENANCE_BACKLOG_INTERVAL_MS : MAINTENANCE_IDLE_INTERVAL_MS;
}

export interface BacklogWatermark {
  readonly lowWater: number;
  readonly lowWaterAtMs: number | null;
  readonly starvedSinceMs: number | null;
}

/**
 * The backlog's low-water mark resets whenever the backlog falls back to it. A backlog that
 * has stayed above its low-water mark for 24 hours has been growing that long: starved.
 */
export function updateBacklogWatermark(
  previous: BacklogWatermark,
  backlog: number,
  nowMs: number,
): BacklogWatermark {
  if (backlog <= 0) return { lowWater: 0, lowWaterAtMs: nowMs, starvedSinceMs: null };
  if (previous.lowWaterAtMs === null || backlog <= previous.lowWater) {
    return { lowWater: backlog, lowWaterAtMs: nowMs, starvedSinceMs: null };
  }
  const starved = nowMs - previous.lowWaterAtMs >= MAINTENANCE_STARVED_AFTER_MS;
  return {
    lowWater: previous.lowWater,
    lowWaterAtMs: previous.lowWaterAtMs,
    starvedSinceMs: starved ? (previous.starvedSinceMs ?? nowMs) : null,
  };
}

/** Events deleted per minute over the last 10 minutes. */
export class DeletionRate {
  private readonly samples: Array<{ readonly atMs: number; readonly rows: number }> = [];

  record(atMs: number, rows: number): void {
    if (rows > 0) this.samples.push({ atMs, rows });
    this.trim(atMs);
  }

  perMinute(nowMs: number): number {
    this.trim(nowMs);
    const total = this.samples.reduce((sum, sample) => sum + sample.rows, 0);
    return total / (MAINTENANCE_RATE_WINDOW_MS / 60_000);
  }

  private trim(nowMs: number): void {
    while (this.samples.length > 0 && nowMs - this.samples[0]!.atMs > MAINTENANCE_RATE_WINDOW_MS) {
      this.samples.shift();
    }
  }
}
