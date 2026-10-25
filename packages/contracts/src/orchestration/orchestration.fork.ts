import { Schema } from "effect";

import { CommandId, EventId, IsoDateTime, MessageId, ThreadId } from "../core/baseSchemas";
import { ModelSelection } from "./orchestration.provider";

/** Why a thread continued in a server-side fork (plan D16). */
export const ThreadForkReason = Schema.Literals([
  "manual",
  "session-dead",
  "recovery-failed",
  "provider-unavailable",
]);
export type ThreadForkReason = typeof ThreadForkReason.Type;

/**
 * How the source's pending (unanswered) message travelled into the fork (plan D17):
 * `sent` when its failure proves it was never admitted, `held` as a held queued prompt otherwise.
 */
export const ThreadForkPendingDelivery = Schema.Literals(["sent", "held"]);
export type ThreadForkPendingDelivery = typeof ThreadForkPendingDelivery.Type;

/**
 * Fork lineage beside `parentThread` (the source). Persisted rows carry the first three fields;
 * `pendingDelivery` exists on the creation event only.
 */
export const ThreadForkOrigin = Schema.Struct({
  forkPointMessageId: Schema.NullOr(MessageId),
  reason: ThreadForkReason,
  /** The source's failure activity that triggered the fork, if any. */
  failureEventId: Schema.NullOr(EventId),
  pendingDelivery: Schema.optional(ThreadForkPendingDelivery),
});
export type ThreadForkOrigin = typeof ThreadForkOrigin.Type;

/** Bounded copy into a fork; newest entries win (plan D16). */
export const THREAD_FORK_CAPS = {
  messages: 200,
  activities: 500,
  proposedPlans: 50,
  tasks: 500,
} as const;

/** Activity on the source naming its fork. */
export const THREAD_FORKED_ACTIVITY_KIND = "thread.forked";
/** Activity on the fork naming its source. */
export const THREAD_FORK_ORIGIN_ACTIVITY_KIND = "thread.fork-origin";

/** Continue a thread in a new server-side fork; idempotent per source failure and message. */
export const ThreadForkCommand = Schema.Struct({
  type: Schema.Literal("thread.fork"),
  commandId: CommandId,
  sourceThreadId: ThreadId,
  threadId: ThreadId,
  reason: ThreadForkReason,
  failureEventId: Schema.optional(EventId),
  pendingMessageId: Schema.optional(MessageId),
  /**
   * Defaults to the source's selection. An automatic fork keeps the source provider; a manual
   * fork may switch provider with the user's explicit selection.
   */
  modelSelection: Schema.optional(ModelSelection),
  createdAt: IsoDateTime,
});
export type ThreadForkCommand = typeof ThreadForkCommand.Type;
