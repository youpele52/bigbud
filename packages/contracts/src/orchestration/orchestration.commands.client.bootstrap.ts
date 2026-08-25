import { Schema } from "effect";

import {
  ExecutionTargetId,
  IsoDateTime,
  ProjectId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.provider";

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  providerRuntimeExecutionTargetId: Schema.optional(ExecutionTargetId),
  workspaceExecutionTargetId: Schema.optional(ExecutionTargetId),
  executionTargetId: Schema.optional(ExecutionTargetId),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
});

export const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});
export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;
