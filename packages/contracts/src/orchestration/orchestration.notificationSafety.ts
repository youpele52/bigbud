import { Schema } from "effect";
import { MessageId, ThreadId, TurnId } from "../core/baseSchemas";
import { OrchestrationTask } from "./orchestration.thread.tasks";

/** Bounded safety evidence for threads whose transcript has not been loaded. */
export const ThreadNotificationSafety = Schema.Struct({
  turnId: Schema.NullOr(TurnId),
  tasks: Schema.Array(OrchestrationTask),
  childThreadIds: Schema.Array(ThreadId),
  childTurns: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        turnId: Schema.NullOr(TurnId),
        requestMessageId: Schema.optional(Schema.NullOr(MessageId)),
        sessionEpoch: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
  pendingRequestIds: Schema.Array(Schema.String),
  queuedPromptIds: Schema.Array(MessageId),
  /** A truncated safety snapshot cannot prove that all work succeeded. */
  overflow: Schema.Boolean,
  hasActionablePlan: Schema.optional(Schema.Boolean),
  selectedPlan: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        turnId: Schema.NullOr(TurnId),
        updatedAt: Schema.String,
        implementedAt: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  pendingStartMessageId: Schema.optional(Schema.NullOr(MessageId)),
  pendingFlush: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        intentId: Schema.String,
        queuedPromptIds: Schema.Array(MessageId),
      }),
    ),
  ),
});
export type ThreadNotificationSafety = typeof ThreadNotificationSafety.Type;
