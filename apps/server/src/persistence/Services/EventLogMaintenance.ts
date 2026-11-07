/**
 * EventLogMaintenance - background, load-safe compaction of the canonical event log and
 * pruning of the command ledgers (receipts, claims, event IDs, gap rows).
 *
 * Deletes only below a floor that every known consumer of old events still needs (see
 * `EventLogMaintenance.floor`), in short adaptive transactions on the shared SQLite worker.
 *
 * @module EventLogMaintenance
 */
import type { EventLogMaintenanceProgress } from "@bigbud/contracts/server/eventLogMaintenance.ts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { AttachmentMaintenanceShape } from "../../attachments/Services/AttachmentMaintenance.ts";
import type { DatabaseCompactionShape } from "./DatabaseCompaction.ts";

/** Other background work the maintenance scheduler drives between ticks; null when absent. */
export interface MaintenanceSchedulerSteps {
  readonly attachments: AttachmentMaintenanceShape | null;
  readonly compaction: DatabaseCompactionShape | null;
}

/** How one tick ran: skipped under load, a forced minimum batch, or a full time-boxed pass. */
export type EventLogMaintenanceTickMode =
  | "skip-hard"
  | "skip-soft"
  | "backoff"
  | "minimum"
  | "full";

export interface EventLogMaintenanceTickReport {
  readonly mode: EventLogMaintenanceTickMode;
  readonly reason: string;
  readonly floorSequence: number;
  readonly retainedThroughSequence: number;
  readonly backlogSequences: number;
  readonly eventsDeleted: number;
  readonly gapsDeleted: number;
  readonly receiptsDeleted: number;
  readonly claimsDeleted: number;
  readonly eventIdsDeleted: number;
  readonly batches: number;
  /** Batches over the 50 ms target. */
  readonly slowBatches: number;
  readonly longestBatchMs: number;
  /** Longest PASSIVE WAL checkpoint run after a batch (its own short worker hold). */
  readonly longestCheckpointMs: number;
  readonly elapsedMs: number;
  /** True when nothing below the floor is left to delete. */
  readonly drained: boolean;
  readonly failed: boolean;
}

export interface EventLogMaintenanceShape {
  /** Latest progress, from memory; never touches the database. */
  readonly progress: Effect.Effect<EventLogMaintenanceProgress>;
  /** Runs one tick now with the normal load rules (used by tests and the copy harness). */
  readonly runTick: Effect.Effect<EventLogMaintenanceTickReport>;
  /**
   * The shared background loop, forever: after a startup delay, one tick and then `steps`
   * (attachment maintenance, the database steady-state step), at the tick cadence.
   */
  readonly runScheduler: (steps: MaintenanceSchedulerSteps) => Effect.Effect<void>;
}

export class EventLogMaintenance extends ServiceMap.Service<
  EventLogMaintenance,
  EventLogMaintenanceShape
>()("bigbud/persistence/Services/EventLogMaintenance") {}
