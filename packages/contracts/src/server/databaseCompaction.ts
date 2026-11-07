import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";

/**
 * One-time database compaction (`VACUUM` with `auto_vacuum = INCREMENTAL`), offered in
 * Settings > Threads once free pages are a large share of the file.
 */
export const DATABASE_COMPACTION_WS_METHODS = {
  getStatus: "server.getDatabaseCompactionStatus",
  preview: "server.previewDatabaseCompaction",
  start: "server.startDatabaseCompaction",
} as const;

/** Why compaction cannot start now. Every one is rechecked on the server when it starts. */
export const DatabaseCompactionBlocker = Schema.Literals([
  /** Free pages are at most 25% of the file or at most 500 MB. */
  "below-threshold",
  /** Free disk is smaller than the database file plus its WAL. */
  "insufficient-disk",
  /** Free disk space could not be read. */
  "disk-unknown",
  /** At least one turn is running. */
  "running-turns",
  /** Background history cleanup still has a large backlog to remove first. */
  "maintenance-backlog",
  /** A compaction is already running. */
  "already-running",
  /**
   * SQLite runs on the backend's main thread (Bun, `BIGBUD_SQLITE_WORKER=0`, or a missing worker
   * entry), so the rebuild would freeze the backend for its whole duration.
   */
  "in-process-sqlite",
]);
export type DatabaseCompactionBlocker = typeof DatabaseCompactionBlocker.Type;

export const DatabaseAutoVacuumMode = Schema.Literals(["none", "full", "incremental"]);
export type DatabaseAutoVacuumMode = typeof DatabaseAutoVacuumMode.Type;

export const DatabaseCompactionPreview = Schema.Struct({
  generatedAt: IsoDateTime,
  /** Main database file size on disk. */
  fileBytes: NonNegativeInt,
  walBytes: NonNegativeInt,
  pageSize: NonNegativeInt,
  pageCount: NonNegativeInt,
  freelistCount: NonNegativeInt,
  /** `freelistCount * pageSize`. */
  freeBytes: NonNegativeInt,
  /** Share of the file's pages that are free, 0 to 1. */
  freeFraction: Schema.Number,
  /** `(pageCount - freelistCount) * pageSize`. */
  expectedBytes: NonNegativeInt,
  autoVacuum: DatabaseAutoVacuumMode,
  /** Free space on the volume holding the database; null when it cannot be read. */
  diskFreeBytes: Schema.NullOr(NonNegativeInt),
  /** Free disk compaction needs: the file plus its WAL. */
  requiredDiskBytes: NonNegativeInt,
  runningTurns: NonNegativeInt,
  /** Event-log sequences background history cleanup may still remove. */
  maintenanceBacklog: NonNegativeInt,
  /** Rough wall time of the rebuild. */
  estimatedDurationMs: NonNegativeInt,
  /** Free pages exceed the offer threshold. */
  offered: Schema.Boolean,
  blockers: Schema.Array(DatabaseCompactionBlocker),
});
export type DatabaseCompactionPreview = typeof DatabaseCompactionPreview.Type;

export const DatabaseCompactionPhase = Schema.Literals(["preparing", "vacuuming", "checkpointing"]);
export type DatabaseCompactionPhase = typeof DatabaseCompactionPhase.Type;

export const DatabaseCompactionRun = Schema.Struct({
  /**
   * `interrupted`: the backend stopped mid-run. `error` says what is known about the file: SQLite
   * keeps the previous file intact, but a run on a file that was already incremental cannot be
   * told apart from a finished one, so its outcome is reported as unknown.
   */
  outcome: Schema.Literals(["completed", "failed", "interrupted"]),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  bytesBefore: Schema.NullOr(NonNegativeInt),
  bytesAfter: Schema.NullOr(NonNegativeInt),
  /** False when readers kept the final WAL truncate from finishing; it is retried later. */
  checkpointComplete: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type DatabaseCompactionRun = typeof DatabaseCompactionRun.Type;

export const DatabaseCompactionStatus = Schema.Struct({
  state: Schema.Literals(["idle", "running"]),
  phase: Schema.NullOr(DatabaseCompactionPhase),
  startedAt: Schema.NullOr(IsoDateTime),
  estimatedDurationMs: Schema.NullOr(NonNegativeInt),
  lastRun: Schema.NullOr(DatabaseCompactionRun),
});
export type DatabaseCompactionStatus = typeof DatabaseCompactionStatus.Type;

export const DatabaseCompactionEmptyInput = Schema.Struct({});
export type DatabaseCompactionEmptyInput = typeof DatabaseCompactionEmptyInput.Type;

export class ServerDatabaseCompactionError extends Schema.TaggedErrorClass<ServerDatabaseCompactionError>()(
  "ServerDatabaseCompactionError",
  {
    code: Schema.Literals([
      "unavailable",
      "below-threshold",
      "insufficient-disk",
      "disk-unknown",
      "running-turns",
      "maintenance-backlog",
      "already-running",
      "in-process-sqlite",
      "failed",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

/** The NativeApi `server` methods for database compaction. */
export interface DatabaseCompactionNativeApi {
  readonly getDatabaseCompactionStatus: (
    input: DatabaseCompactionEmptyInput,
  ) => Promise<DatabaseCompactionStatus>;
  readonly previewDatabaseCompaction: (
    input: DatabaseCompactionEmptyInput,
  ) => Promise<DatabaseCompactionPreview>;
  readonly startDatabaseCompaction: (
    input: DatabaseCompactionEmptyInput,
  ) => Promise<DatabaseCompactionStatus>;
}
