import { Schema } from "effect";
import {
  ExecutionTargetId,
  IsoDateTime,
  ProjectId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { HistoricalModelSelection } from "./orchestration.provider";

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
});
export type ProjectScript = typeof ProjectScript.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  providerRuntimeExecutionTargetId: Schema.optional(ExecutionTargetId),
  workspaceExecutionTargetId: Schema.optional(ExecutionTargetId),
  executionTargetId: Schema.optional(ExecutionTargetId),
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  workspaceKind: Schema.optional(Schema.Literals(["managed", "external"])),
  previousWorkspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultModelSelection: Schema.NullOr(HistoricalModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletingAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;
