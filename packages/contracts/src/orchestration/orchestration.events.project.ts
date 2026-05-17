import { Schema } from "effect";
import {
  ExecutionTargetId,
  IsoDateTime,
  ProjectId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { ModelSelection } from "./orchestration.provider";
import { ProjectScript } from "./orchestration.project";

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  providerRuntimeExecutionTargetId: Schema.optional(ExecutionTargetId),
  workspaceExecutionTargetId: Schema.optional(ExecutionTargetId),
  executionTargetId: Schema.optional(ExecutionTargetId),
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  providerRuntimeExecutionTargetId: Schema.optional(ExecutionTargetId),
  workspaceExecutionTargetId: Schema.optional(ExecutionTargetId),
  executionTargetId: Schema.optional(ExecutionTargetId),
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ProjectDeletionRequestedPayload = Schema.Struct({
  projectId: ProjectId,
  deletingAt: IsoDateTime,
});

export const ProjectDeletionFailedPayload = Schema.Struct({
  projectId: ProjectId,
  updatedAt: IsoDateTime,
});
