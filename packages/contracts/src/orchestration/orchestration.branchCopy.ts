import { Schema } from "effect";

import {
  CommandId,
  ExecutionTargetId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.provider";
import { OrchestrationMessage } from "./orchestration.thread";

/**
 * Starts a server-side branch: the server creates `branchThreadId` and copies the source's
 * messages from its projection, in full and in bounded batches. The client sends only ids and
 * the branch's metadata, never message content. The branch keeps no link to its source, so
 * deleting or retention-removing the source never touches it.
 */
export const StartThreadBranchInput = Schema.Struct({
  sourceThreadId: ThreadId,
  branchThreadId: ThreadId,
  /** Last message copied (inclusive); null copies every settled message present now. */
  upToMessageId: Schema.NullOr(MessageId),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  providerRuntimeExecutionTargetId: Schema.optional(ExecutionTargetId),
  workspaceExecutionTargetId: Schema.optional(ExecutionTargetId),
  createdAt: IsoDateTime,
});
export type StartThreadBranchInput = typeof StartThreadBranchInput.Type;

export const ThreadBranchCopyState = Schema.Literals(["copying", "completed", "failed"]);
export type ThreadBranchCopyState = typeof ThreadBranchCopyState.Type;

export const ThreadBranchCopyStatus = Schema.Struct({
  branchThreadId: ThreadId,
  state: ThreadBranchCopyState,
  copiedMessages: NonNegativeInt,
  /** Messages up to the branch point when the branch was requested. */
  totalMessages: NonNegativeInt,
  error: Schema.NullOr(Schema.String),
});
export type ThreadBranchCopyStatus = typeof ThreadBranchCopyStatus.Type;

export const GetThreadBranchCopyInput = Schema.Struct({ branchThreadId: ThreadId });
export type GetThreadBranchCopyInput = typeof GetThreadBranchCopyInput.Type;

/** Null when the thread was not created by a server-side branch. */
export const GetThreadBranchCopyResult = Schema.NullOr(ThreadBranchCopyStatus);
export type GetThreadBranchCopyResult = typeof GetThreadBranchCopyResult.Type;

/** Internal: one bounded batch of copied messages, appended to the branch in order. */
export const ThreadBranchCopyAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.branch-copy.append"),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(OrchestrationMessage),
  createdAt: IsoDateTime,
});
export type ThreadBranchCopyAppendCommand = typeof ThreadBranchCopyAppendCommand.Type;

export class OrchestrationStartThreadBranchError extends Schema.TaggedErrorClass<OrchestrationStartThreadBranchError>()(
  "OrchestrationStartThreadBranchError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetThreadBranchCopyError extends Schema.TaggedErrorClass<OrchestrationGetThreadBranchCopyError>()(
  "OrchestrationGetThreadBranchCopyError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** The branch methods on `NativeApi["orchestration"]`. */
export interface ThreadBranchNativeApi {
  readonly startThreadBranch: (input: StartThreadBranchInput) => Promise<ThreadBranchCopyStatus>;
  readonly getThreadBranchCopy: (
    input: GetThreadBranchCopyInput,
  ) => Promise<GetThreadBranchCopyResult>;
}
