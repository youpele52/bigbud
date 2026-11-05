import { Schema } from "effect";

/** A known refusal of this attempt; it does not imply delivery or schedule a retry. */
export const QueueDecisionReason = Schema.Literals([
  "queue_busy",
  "queue_pending_start",
  "queue_waiting_for_user",
  "queue_held",
  "queue_reserved",
  "queue_stale_selection",
  "queue_stale_turn",
  "queue_invalid_owner",
  "queue_incompatible_reservation",
  "queue_unavailable",
]);
export type QueueDecisionReason = typeof QueueDecisionReason.Type;
