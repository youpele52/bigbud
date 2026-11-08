import { Schema } from "effect";
import {
  CommandId,
  ExecutionTargetId,
  IsoDateTime,
  ProjectId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";

export const ProjectReconfigureCommand = Schema.Struct({
  type: Schema.Literal("project.reconfigure"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  providerRuntimeExecutionTargetId: ExecutionTargetId,
  workspaceExecutionTargetId: ExecutionTargetId,
  executionTargetId: ExecutionTargetId,
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  expectedUpdatedAt: IsoDateTime,
  verifiedWorktreePaths: Schema.Array(TrimmedNonEmptyString),
  workspaceAction: Schema.optional(Schema.Literals(["switch", "transfer"])),
  nativeContextReset: Schema.optional(Schema.Literal("archive-and-reset-muse")),
});
