/**
 * Pure rules for database compaction: when the rebuild is offered, what blocks it, how long it
 * may take, and when the steady-state incremental vacuum runs. No I/O.
 *
 * @module DatabaseCompaction.policy
 */
import type {
  DatabaseAutoVacuumMode,
  DatabaseCompactionBlocker,
} from "@bigbud/contracts/server/databaseCompaction.ts";

export interface CompactionThresholds {
  /** Offer the rebuild only above this share of free pages. */
  readonly minFreeFraction: number;
  /** ...and only above this many free bytes. */
  readonly minFreeBytes: number;
  /**
   * Event-log sequences background cleanup may still have to remove. The hot window keeps
   * advancing, so a drained log still shows a small backlog between ticks; only a larger one
   * means cleanup is mid-drain and compacting now would leave space behind.
   */
  readonly maxMaintenanceBacklog: number;
}

export const DEFAULT_COMPACTION_THRESHOLDS: CompactionThresholds = {
  minFreeFraction: 0.25,
  minFreeBytes: 500 * 1024 * 1024,
  maxMaintenanceBacklog: 20_000,
};

export const STEADY_STATE = {
  /** Incremental vacuum runs only above this share of free pages. */
  minFreeFraction: 0.1,
  /**
   * Pages released per step: about 4 MB with 4 KB pages. Measured on the rebuilt real database
   * (921 MB): 2,048 pages took 34-35 ms, because their ~2,070 WAL frames trip the 1,000-page
   * autocheckpoint inside the statement; 1,024 pages took 15-19 ms, inside the 40% headroom the
   * maintenance batches keep under their 50 ms target.
   */
  incrementalPages: 1_024,
  journalSizeLimitBytes: 64 * 1024 * 1024,
} as const;

/**
 * Throughput of a rebuild, calibrated on the real database: `VACUUM` copies only live pages (the
 * free list is never read), writing them to a temporary copy and the WAL, and the closing
 * checkpoint writes them once more. A drained 8.26 GB file with about 1 GB live rebuilt in about
 * 7 s, ~150 MB/s of live content end to end. The rates below keep about 1.5x headroom for
 * slower disks, plus a small per-gigabyte cost for walking the old file's b-trees.
 */
const SCAN_BYTES_PER_SECOND = 4 * 1024 * 1024 * 1024;
const LIVE_BYTES_PER_SECOND = 100 * 1024 * 1024;
const FIXED_OVERHEAD_MS = 1_000;

export interface DatabasePageStats {
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistCount: number;
  readonly autoVacuum: DatabaseAutoVacuumMode;
}

export const toAutoVacuumMode = (value: number | null | undefined): DatabaseAutoVacuumMode =>
  value === 2 ? "incremental" : value === 1 ? "full" : "none";

export const freeFraction = (stats: DatabasePageStats): number =>
  stats.pageCount > 0 ? stats.freelistCount / stats.pageCount : 0;

export const expectedBytesAfterCompaction = (stats: DatabasePageStats): number =>
  Math.max(0, stats.pageCount - stats.freelistCount) * stats.pageSize;

export const estimateCompactionDurationMs = (fileBytes: number, expectedBytes: number): number =>
  Math.round(
    FIXED_OVERHEAD_MS +
      (fileBytes / SCAN_BYTES_PER_SECOND) * 1_000 +
      (expectedBytes / LIVE_BYTES_PER_SECOND) * 1_000,
  );

export const isCompactionOffered = (
  stats: DatabasePageStats,
  thresholds: CompactionThresholds = DEFAULT_COMPACTION_THRESHOLDS,
): boolean =>
  freeFraction(stats) > thresholds.minFreeFraction &&
  stats.freelistCount * stats.pageSize > thresholds.minFreeBytes;

/** Free space on SQLite's temp directory, where `VACUUM` builds its copy. */
export interface TempDiskSpace {
  /** True when the temp directory shares the database's volume (the database check covers it). */
  readonly sameVolume: boolean;
  /** Null when unreadable. */
  readonly freeBytes: number | null;
}

/** Margin over the estimated peak write, for the page and file-system overhead it omits. */
const DISK_HEADROOM = 1.1;

/**
 * Peak disk use of the rebuild. `VACUUM` writes the live pages into a temp copy, then copies
 * them into the WAL, so the database volume needs about twice the live data (never less than
 * the file, the conservative bound) plus the WAL already there. A temp directory on another
 * volume needs the live data there instead.
 */
export function requiredCompactionDiskBytes(input: {
  readonly stats: DatabasePageStats;
  readonly fileBytes: number;
  readonly walBytes: number;
}): { readonly database: number; readonly temp: number } {
  const liveBytes = expectedBytesAfterCompaction(input.stats);
  return {
    database: Math.ceil(
      (Math.max(input.fileBytes, 2 * liveBytes) + input.walBytes) * DISK_HEADROOM,
    ),
    temp: Math.ceil(liveBytes * DISK_HEADROOM),
  };
}

export interface CompactionBlockerInput {
  readonly stats: DatabasePageStats;
  readonly fileBytes: number;
  readonly walBytes: number;
  readonly diskFreeBytes: number | null;
  readonly tempDisk: TempDiskSpace;
  readonly runningTurns: number;
  /** Null when background maintenance is not running in this process. */
  readonly maintenance: {
    readonly backlogSequences: number;
    readonly disabled: boolean;
    readonly starved: boolean;
  } | null;
  readonly running: boolean;
  /** SQLite runs on the backend's main thread, so `VACUUM` would block every request. */
  readonly inProcessSqlite?: boolean;
}

/** Every reason the rebuild cannot start now, in the order the user should resolve them. */
export function compactionBlockers(
  input: CompactionBlockerInput,
  thresholds: CompactionThresholds = DEFAULT_COMPACTION_THRESHOLDS,
): Array<DatabaseCompactionBlocker> {
  const blockers: Array<DatabaseCompactionBlocker> = [];
  if (input.running) blockers.push("already-running");
  if (input.inProcessSqlite === true) blockers.push("in-process-sqlite");
  if (!isCompactionOffered(input.stats, thresholds)) blockers.push("below-threshold");
  const required = requiredCompactionDiskBytes(input);
  const tempFreeBytes = input.tempDisk.sameVolume
    ? Number.POSITIVE_INFINITY
    : input.tempDisk.freeBytes;
  if (input.diskFreeBytes === null || tempFreeBytes === null) blockers.push("disk-unknown");
  else if (input.diskFreeBytes < required.database || tempFreeBytes < required.temp)
    blockers.push("insufficient-disk");
  if (input.runningTurns > 0) blockers.push("running-turns");
  // A starved or disabled cleanup will not drain; waiting for it would block compaction forever.
  const maintenance = input.maintenance;
  if (
    maintenance !== null &&
    !maintenance.disabled &&
    !maintenance.starved &&
    maintenance.backlogSequences > thresholds.maxMaintenanceBacklog
  ) {
    blockers.push("maintenance-backlog");
  }
  return blockers;
}

export const COMPACTION_BLOCKER_MESSAGES: Record<DatabaseCompactionBlocker, string> = {
  "already-running": "Database compaction is already running.",
  "below-threshold": "The database has too little free space to be worth compacting.",
  "insufficient-disk":
    "Not enough free disk space: compaction needs about twice the live data, plus room for its temporary copy.",
  "disk-unknown": "Free disk space could not be read, so compaction cannot start safely.",
  "running-turns": "A turn is running. Wait for it to finish before compacting.",
  "maintenance-backlog":
    "History cleanup is still removing old events. Compact once it has caught up.",
  "in-process-sqlite":
    "This backend runs SQLite on its main thread (development mode, BIGBUD_SQLITE_WORKER=0 or a missing worker), so compaction would freeze it. Run it from a backend that uses the SQLite worker.",
};

/** The steady-state incremental vacuum only works once the file is in incremental mode. */
export const shouldRunIncrementalVacuum = (stats: DatabasePageStats): boolean =>
  stats.autoVacuum === "incremental" && freeFraction(stats) > STEADY_STATE.minFreeFraction;
