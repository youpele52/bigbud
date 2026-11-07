/**
 * How the shared maintenance scheduler (`EventLogMaintenance.steps`) drives attachment
 * maintenance: cadence, per-tick budgets and the progress log. The tick runs under the
 * event-log scheduler's load backoff and guaranteed-progress rule; there is no separate loop.
 *
 * @module AttachmentMaintenance.scheduler
 */
import * as Effect from "effect/Effect";

import type { AttachmentMaintenanceTickResult } from "../Services/AttachmentMaintenance.ts";

export const ATTACHMENT_MAINTENANCE_SCHEDULE = {
  /** Between ticks while the last one reported no backlog. */
  idleIntervalMs: 5 * 60_000,
  /** Between ticks while a backlog remains. */
  backlogIntervalMs: 15_000,
  /** Budget of a normal tick (the database is idle enough for a full event-log pass). */
  budgetMs: 1_000,
  /** Budget of a guaranteed-progress tick under soft load. */
  minimumBudgetMs: 50,
} as const;

export const logAttachmentMaintenanceTick = (result: AttachmentMaintenanceTickResult) =>
  result.processed > 0 || result.sweep.failed > 0
    ? Effect.logInfo("attachment maintenance progressed", {
        processed: result.processed,
        backlog: result.backlog,
        recorded: result.backfill.recorded,
        trashed: result.sweep.trashed,
        deleted: result.sweep.deleted,
        restored: result.sweep.restored,
        uploadDirectoriesRemoved: result.sweep.uploadDirectoriesRemoved,
        held: result.sweep.held,
        failed: result.sweep.failed,
        durationMs: Math.round(result.durationMs),
      })
    : Effect.void;
