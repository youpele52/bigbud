import { Schema } from "effect";

import { CommandId, IsoDateTime, MessageId, NonNegativeInt, ThreadId } from "../core/baseSchemas";
import { ProviderKind } from "./orchestration.provider";

/**
 * Stop disposition of a durable recovery intent (one per accepted turn).
 *
 * - `active`: the turn may still need recovery.
 * - `suspended-for-exit`: app exit or `stopAll` paused it; nothing resumes it in this slice.
 * - `revoked`: the user stopped the turn; it is never resumed.
 * - `settled`: the turn finished or recovery was resolved.
 */
export const ThreadRecoveryDisposition = Schema.Literals([
  "active",
  "suspended-for-exit",
  "revoked",
  "settled",
]);
export type ThreadRecoveryDisposition = typeof ThreadRecoveryDisposition.Type;

/** Recovery status of an intent, and of the thread projection's `recovery` field. */
export const ThreadRecoveryStatus = Schema.Literals([
  "none",
  "interrupted-by-sleep",
  "observing",
  "continuing",
  "awaiting-user",
  "parked",
  "provider-continued",
  "continued",
]);
export type ThreadRecoveryStatus = typeof ThreadRecoveryStatus.Type;

/** Why recovery is in its current status. Absent when the status says enough. */
export const ThreadRecoveryReason = Schema.Literals([
  "interrupted-by-sleep",
  "tool-in-flight",
  "no-activity-after-wake",
  "backend-restarted-after-wake",
  "continuation-failed",
  "provider-continued",
]);
export type ThreadRecoveryReason = typeof ThreadRecoveryReason.Type;

/** Delivery progress of one provider dispatch attempt for an intent. */
export const ProviderDispatchAttemptState = Schema.Literals([
  "prepared",
  "may-have-been-sent",
  "provider-acknowledged",
]);
export type ProviderDispatchAttemptState = typeof ProviderDispatchAttemptState.Type;

/**
 * The thread's visible recovery state. `messageId` is the user message of the interrupted
 * turn, so a stale resolve can be refused. `attempt` counts bigbud's own automatic
 * continuation sends only.
 */
export const ThreadRecovery = Schema.Struct({
  status: ThreadRecoveryStatus,
  reason: Schema.NullOr(ThreadRecoveryReason),
  toolSummary: Schema.NullOr(Schema.String),
  attempt: NonNegativeInt,
  provider: Schema.NullOr(ProviderKind),
  messageId: MessageId,
  updatedAt: IsoDateTime,
});
export type ThreadRecovery = typeof ThreadRecovery.Type;

/** User actions on a recovery prompt. Continue and Retry never count toward parking. */
export const ThreadRecoveryResolveAction = Schema.Literals([
  "continue",
  "dismiss",
  "retry",
  "keep-waiting",
  "stop-and-continue",
]);
export type ThreadRecoveryResolveAction = typeof ThreadRecoveryResolveAction.Type;

/** Client command: act on the thread's recovery prompt. */
export const ThreadRecoveryResolveCommand = Schema.Struct({
  type: Schema.Literal("thread.recovery.resolve"),
  commandId: CommandId,
  threadId: ThreadId,
  action: ThreadRecoveryResolveAction,
  /** The interrupted turn's message. When present and stale, the server refuses the action. */
  messageId: Schema.optional(MessageId),
  createdAt: IsoDateTime,
});
export type ThreadRecoveryResolveCommand = typeof ThreadRecoveryResolveCommand.Type;

/** Internal command: the recovery coordinator publishes a new recovery state. */
export const ThreadRecoverySetCommand = Schema.Struct({
  type: Schema.Literal("thread.recovery.set"),
  commandId: CommandId,
  threadId: ThreadId,
  recovery: Schema.NullOr(ThreadRecovery),
  messageId: Schema.optional(MessageId),
  createdAt: IsoDateTime,
});
export type ThreadRecoverySetCommand = typeof ThreadRecoverySetCommand.Type;

/**
 * `thread.recovery-updated` payload. `recovery: null` clears the notice. `resolvedAction`
 * is set when a user's `thread.recovery.resolve` produced the update; the coordinator acts
 * on it.
 */
export const ThreadRecoveryUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  recovery: Schema.NullOr(ThreadRecovery),
  /** The interrupted turn's message this update concerns, also when `recovery` is null. */
  messageId: Schema.optional(MessageId),
  resolvedAction: Schema.optional(ThreadRecoveryResolveAction),
  createdAt: IsoDateTime,
});
export type ThreadRecoveryUpdatedPayload = typeof ThreadRecoveryUpdatedPayload.Type;
