import { Schema } from "effect";
import { CommandId, IsoDateTime, MessageId, ThreadId } from "../core/baseSchemas";

const ThreadQueueRecoveryFields = {
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
};

export const ThreadQueuedPromptClaimCommand = Schema.Struct({
  ...ThreadQueueRecoveryFields,
  type: Schema.Literal("thread.queued-prompt.claim"),
  messageId: MessageId,
  promptCreatedAt: IsoDateTime,
  alreadySent: Schema.Boolean,
});

export const ThreadRecoveredPromptCommand = Schema.Struct({
  ...ThreadQueueRecoveryFields,
  type: Schema.Literal("thread.queued-prompt.recovered"),
  claimId: CommandId,
  action: Schema.Literals(["send", "discard"]),
});
