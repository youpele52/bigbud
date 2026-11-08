import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt } from "../core/baseSchemas";

/** What currently holds the event-log compaction floor lowest. */
export const EventLogFloorHolder = Schema.Literals([
  "baseline",
  "projector",
  "reactor",
  "delivery",
  "hot-window",
  "cleanup",
  "turn-start",
  "organization",
  "workspace",
]);
export type EventLogFloorHolder = typeof EventLogFloorHolder.Type;

/**
 * Background event-log maintenance (history compaction and ledger pruning), as shown in
 * Settings > Diagnostics. `backlogSequences` counts sequences that may be compacted but are
 * not yet; `starved` is set once that backlog has not shrunk back for 24 hours. `floorPinned` is
 * set once one holder (other than the hot window or a bounded undo window) has held the floor for
 * 24 hours, whatever the backlog says: a pinned floor reads as backlog 0.
 */
export const EventLogMaintenanceProgress = Schema.Struct({
  state: Schema.Literals(["waiting", "idle", "draining", "backing-off", "disabled"]),
  backlogSequences: NonNegativeInt,
  floorSequence: NonNegativeInt,
  floorHeldBy: Schema.NullOr(EventLogFloorHolder),
  floorPinned: Schema.optional(Schema.Boolean),
  floorPinnedSince: Schema.optional(Schema.NullOr(IsoDateTime)),
  retainedThroughSequence: NonNegativeInt,
  ratePerMinute: Schema.Number,
  lastBatchAt: Schema.NullOr(IsoDateTime),
  longestBatchMs: Schema.Number,
  starved: Schema.Boolean,
  starvedSince: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  lastErrorAt: Schema.NullOr(IsoDateTime),
  backoffUntil: Schema.NullOr(IsoDateTime),
});
export type EventLogMaintenanceProgress = typeof EventLogMaintenanceProgress.Type;
