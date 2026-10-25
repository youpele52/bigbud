import { Schema } from "effect";
import {
  CommandId,
  ThreadId,
  ProjectId,
  ExecutionTargetId,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
} from "./orchestration.provider";
import {
  OrchestrationThreadPurpose,
  OrchestrationMessage,
  ParentThreadReference,
} from "./orchestration.thread";
import { WorktreeBinding } from "../workspace/worktreeBinding";

export const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  purpose: Schema.optional(OrchestrationThreadPurpose),
  providerRuntimeExecutionTargetId: Schema.optional(ExecutionTargetId),
  workspaceExecutionTargetId: Schema.optional(ExecutionTargetId),
  executionTargetId: Schema.optional(ExecutionTargetId),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  worktreeBinding: Schema.optional(WorktreeBinding),
  parentThread: Schema.optional(ParentThreadReference),
  seedMessages: Schema.optional(Schema.Array(OrchestrationMessage)),
  createdAt: IsoDateTime,
});
