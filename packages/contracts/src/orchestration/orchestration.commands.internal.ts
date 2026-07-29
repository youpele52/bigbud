import { Schema } from "effect";
import {
  CheckpointRef,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../core/baseSchemas";
import {
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationTask,
  OrchestrationTaskFreshness,
  OrchestrationTaskSource,
  OrchestrationThreadActivity,
} from "./orchestration.thread";

const ProjectDeleteFinalizeCommand = Schema.Struct({
  type: Schema.Literal("project.delete.finalize"),
  commandId: CommandId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
});

const ProjectDeleteAbortCommand = Schema.Struct({
  type: Schema.Literal("project.delete.abort"),
  commandId: CommandId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
});

const ThreadDeleteFinalizeCommand = Schema.Struct({
  type: Schema.Literal("thread.delete.finalize"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadDeleteAbortCommand = Schema.Struct({
  type: Schema.Literal("thread.delete.abort"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadTurnStartFailedCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start.failed"),
  commandId: CommandId,
  threadId: ThreadId,
  context: Schema.Literals(["message-validation", "provider-session-start", "provider-turn-start"]),
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantReplaceCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.replace"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadTaskUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.task.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  task: OrchestrationTask,
  createdAt: IsoDateTime,
});

const ThreadTaskRemoveCommand = Schema.Struct({
  type: Schema.Literal("thread.task.remove"),
  commandId: CommandId,
  threadId: ThreadId,
  taskId: RuntimeTaskId,
  source: OrchestrationTaskSource,
  freshness: OrchestrationTaskFreshness,
  replacement: Schema.optional(Schema.Literals(["snapshot", "explicit"])),
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const InternalOrchestrationCommand = Schema.Union([
  ProjectDeleteFinalizeCommand,
  ProjectDeleteAbortCommand,
  ThreadDeleteFinalizeCommand,
  ThreadDeleteAbortCommand,
  ThreadSessionSetCommand,
  ThreadTurnStartFailedCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantReplaceCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadTaskUpsertCommand,
  ThreadTaskRemoveCommand,
  ThreadRevertCompleteCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;
