/**
 * AttachmentMaintenance - bounded upkeep of the managed attachments directory.
 *
 * One `runTick` does a slice of two jobs and returns how far it got:
 * - ownership backfill: records device, inode and hash for legacy files (written before
 *   migration 121) that a live thread references, so normal thread deletion can remove them;
 * - orphan sweep: moves unreferenced files past the grace period into `attachments/.trash/`,
 *   restores trashed files that are referenced again, and deletes trash past its retention;
 * - staging cleanup: removes empty `.submission-upload-*` directories older than 1 day.
 *
 * `runTick` is independent of any loop: the event-log maintenance scheduler calls it under its
 * load backoff and guaranteed-progress rule.
 *
 * @module AttachmentMaintenance
 */
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

export class AttachmentMaintenanceError extends Data.TaggedError("AttachmentMaintenanceError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface AttachmentMaintenanceTickOptions {
  /** Wall-clock budget for the tick; work stops at the first file boundary past it. */
  readonly budgetMs?: number;
  /** Clock override for grace and trash ages (tests). Defaults to `Date.now()`. */
  readonly nowMs?: number;
}

export interface AttachmentBackfillProgress {
  /** Reference rows examined this tick. */
  readonly scanned: number;
  readonly recorded: number;
  /** Candidates left without ownership: missing, ambiguous, unsafe or changed while hashing. */
  readonly skipped: number;
  /** Known candidates not yet examined, at least 1 while a pass is unfinished. */
  readonly pending: number;
}

export interface AttachmentSweepProgress {
  /** Managed-layout files examined this tick. */
  readonly scanned: number;
  readonly trashed: number;
  readonly deleted: number;
  readonly restored: number;
  /** Empty `.submission-upload-*` staging directories older than 1 day that were removed. */
  readonly uploadDirectoriesRemoved: number;
  /** Old unreferenced files kept for a staged upload, an in-flight deletion or blocked ownership. */
  readonly held: number;
  readonly failed: number;
  /** Orphans, due trash and restores found but left for a later tick, plus unscanned files. */
  readonly pending: number;
}

export interface AttachmentMaintenanceTickResult {
  readonly status: "completed" | "skipped-in-flight" | "skipped-unavailable";
  /** Lower bound of remaining work items; 0 means caught up. */
  readonly backlog: number;
  /**
   * File operations done: ownership rows recorded, files trashed, deleted or restored, and
   * staging directories removed.
   */
  readonly processed: number;
  readonly budgetExhausted: boolean;
  readonly durationMs: number;
  readonly backfill: AttachmentBackfillProgress;
  readonly sweep: AttachmentSweepProgress;
}

export interface AttachmentMaintenanceShape {
  readonly runTick: (
    options?: AttachmentMaintenanceTickOptions,
  ) => Effect.Effect<AttachmentMaintenanceTickResult, AttachmentMaintenanceError>;
}

export class AttachmentMaintenance extends ServiceMap.Service<
  AttachmentMaintenance,
  AttachmentMaintenanceShape
>()("bigbud/attachments/Services/AttachmentMaintenance") {}
