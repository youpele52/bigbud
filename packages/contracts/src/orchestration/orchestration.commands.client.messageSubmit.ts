import { Schema } from "effect";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "../core/baseSchemas";
import { ChatAttachment, UploadChatAttachment } from "./orchestration.attachments";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.provider";
import { SourceProposedPlanReference } from "./orchestration.thread";
import { ThreadTurnStartBootstrap } from "./orchestration.commands.client.bootstrap";

/** Server-side form with normalized attachments. */
export const ThreadMessageSubmitCommand = Schema.Struct({
  type: Schema.Literal("thread.message.submit"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    text: TrimmedString,
    /** Optional for backwards-compatible agent-to-agent submissions. */
    attachments: Schema.optional(Schema.Array(ChatAttachment)),
    replyToMessageId: Schema.optional(MessageId),
  }).check(
    Schema.makeFilter(
      (message) => message.text.length > 0 || (message.attachments?.length ?? 0) > 0,
      { identifier: "MessageSubmissionContent" },
    ),
  ),
  /** Explicit execution settings are retained with supported queued submissions. */
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  bootstrapSourceThreadId: Schema.optional(ThreadId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  delivery: Schema.Literals(["auto", "queue"]).pipe(
    Schema.withDecodingDefault(() => "auto" as const),
  ),
  createdAt: IsoDateTime,
});

/** Client form; Normalizer converts upload attachments to ChatAttachment. */
export const ClientThreadMessageSubmitCommand = Schema.Struct({
  type: Schema.Literal("thread.message.submit"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    text: TrimmedString,
    attachments: Schema.optional(Schema.Array(UploadChatAttachment)),
    replyToMessageId: Schema.optional(MessageId),
  }).check(
    Schema.makeFilter(
      (message) => message.text.length > 0 || (message.attachments?.length ?? 0) > 0,
      { identifier: "MessageSubmissionContent" },
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  bootstrapSourceThreadId: Schema.optional(ThreadId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  delivery: Schema.Literals(["auto", "queue"]).pipe(
    Schema.withDecodingDefault(() => "auto" as const),
  ),
  createdAt: IsoDateTime,
});
