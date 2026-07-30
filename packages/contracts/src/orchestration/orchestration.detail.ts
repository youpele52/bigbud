import { Schema } from "effect";

import {
  ApprovalRequestId,
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TurnId,
} from "../core/baseSchemas";
import { ChatAttachment } from "./orchestration.attachments";
import { UserInputQuestion } from "./providerRuntime.payloads";
import {
  OrchestrationCheckpointStatus,
  OrchestrationMessageReply,
  OrchestrationMessageRole,
  OrchestrationProposedPlan,
  OrchestrationTask,
  OrchestrationThreadActivity,
} from "./orchestration.thread";

export const THREAD_DETAIL_MESSAGE_DEFAULT_LIMIT = 50;
export const THREAD_DETAIL_MESSAGE_MAX_LIMIT = 200;
export const THREAD_DETAIL_ACTIVITY_DEFAULT_LIMIT = 100;
export const THREAD_DETAIL_ACTIVITY_MAX_LIMIT = 200;
export const THREAD_DETAIL_APPROVAL_DEFAULT_LIMIT = 10;
export const THREAD_DETAIL_APPROVAL_MAX_LIMIT = 50;
export const THREAD_DETAIL_USER_INPUT_DEFAULT_LIMIT = THREAD_DETAIL_APPROVAL_DEFAULT_LIMIT;
export const THREAD_DETAIL_USER_INPUT_MAX_LIMIT = THREAD_DETAIL_APPROVAL_MAX_LIMIT;
export const THREAD_DETAIL_USER_INPUT_QUESTION_MAX_LIMIT = 20;
export const THREAD_DETAIL_TASK_DEFAULT_LIMIT = 50;
export const THREAD_DETAIL_TASK_MAX_LIMIT = 100;
export const THREAD_DETAIL_CHECKPOINT_DEFAULT_LIMIT = 10;
export const THREAD_DETAIL_CHECKPOINT_MAX_LIMIT = 50;
export const THREAD_DETAIL_MESSAGE_ATTACHMENT_MAX_LIMIT = 20;

export const ThreadDetailMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  attachmentsTruncated: Schema.Boolean,
  replyTo: Schema.optional(OrchestrationMessageReply),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadDetailMessage = typeof ThreadDetailMessage.Type;

export const ThreadDetailCheckpoint = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ThreadDetailCheckpoint = typeof ThreadDetailCheckpoint.Type;

export const ThreadMessageCursor = Schema.Struct({
  createdAt: IsoDateTime,
  messageId: MessageId,
});
export type ThreadMessageCursor = typeof ThreadMessageCursor.Type;

export const ThreadMessageWindowBounds = Schema.Struct({
  order: Schema.Literal("newest-first"),
  requestedCursor: Schema.NullOr(ThreadMessageCursor),
  newestCursor: Schema.NullOr(ThreadMessageCursor),
  oldestCursor: Schema.NullOr(ThreadMessageCursor),
  nextCursor: Schema.NullOr(ThreadMessageCursor),
  hasOlder: Schema.Boolean,
});
export type ThreadMessageWindowBounds = typeof ThreadMessageWindowBounds.Type;

export const ThreadDetailPendingApproval = Schema.Struct({
  requestId: ApprovalRequestId,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
});
export type ThreadDetailPendingApproval = typeof ThreadDetailPendingApproval.Type;

export const ThreadDetailPendingUserInput = Schema.Struct({
  requestId: ApprovalRequestId,
  turnId: Schema.NullOr(TurnId),
  questions: Schema.Array(UserInputQuestion),
  questionsTruncated: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type ThreadDetailPendingUserInput = typeof ThreadDetailPendingUserInput.Type;

export const GetSelectedThreadDetailInput = Schema.Struct({
  threadId: ThreadId,
  messageLimit: Schema.optional(PositiveInt),
  activityLimit: Schema.optional(PositiveInt),
  approvalLimit: Schema.optional(PositiveInt),
  userInputLimit: Schema.optional(PositiveInt),
  taskLimit: Schema.optional(PositiveInt),
  checkpointLimit: Schema.optional(PositiveInt),
  messageCursor: Schema.optional(ThreadMessageCursor),
});
export type GetSelectedThreadDetailInput = typeof GetSelectedThreadDetailInput.Type;

export const GetSelectedThreadDetailResult = Schema.Struct({
  projectionSequence: NonNegativeInt,
  threadId: ThreadId,
  projectId: ProjectId,
  activityTurnId: Schema.NullOr(TurnId),
  messages: Schema.Array(ThreadDetailMessage),
  messageWindow: ThreadMessageWindowBounds,
  activities: Schema.Array(OrchestrationThreadActivity),
  activitiesTruncated: Schema.Boolean,
  pendingApprovals: Schema.Array(ThreadDetailPendingApproval),
  pendingApprovalsTruncated: Schema.Boolean,
  pendingUserInputs: Schema.Array(ThreadDetailPendingUserInput),
  pendingUserInputsTruncated: Schema.Boolean,
  activePlan: Schema.NullOr(OrchestrationProposedPlan),
  activeTasks: Schema.Array(OrchestrationTask),
  activeTasksTruncated: Schema.Boolean,
  checkpoints: Schema.Array(ThreadDetailCheckpoint),
  checkpointsTruncated: Schema.Boolean,
});
export type GetSelectedThreadDetailResult = typeof GetSelectedThreadDetailResult.Type;
