import { Schema } from "effect";
import { ThreadId } from "../core/baseSchemas";

const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384));
export const WorktreeContext = Schema.Struct({
  cwd: Path,
  executionTargetId: Schema.optional(Schema.String),
  selectedPath: Schema.optional(Path),
});
export type WorktreeContext = typeof WorktreeContext.Type;
export const WorktreeCreate = Schema.Struct({
  ...WorktreeContext.fields,
  operationId: Path,
  name: Path,
  branch: Path,
  newBranch: Path,
});
export type WorktreeCreate = typeof WorktreeCreate.Type;

export const WorktreeEntry = Schema.Struct({
  identity: Schema.optional(Schema.String),
  path: Path,
  name: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  main: Schema.Boolean,
  bare: Schema.Boolean,
  locked: Schema.NullOr(Schema.String),
  prunable: Schema.NullOr(Schema.String),
});
export type WorktreeEntry = typeof WorktreeEntry.Type;

export const WorktreeInventory = Schema.Struct({
  repository: Path,
  revision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  checkoutPath: Path,
  selectedPath: Schema.optional(Path),
  entries: Schema.Array(WorktreeEntry),
  linkedCount: Schema.Number,
  local: Schema.Boolean,
  issues: Schema.optional(Schema.Array(Schema.String)),
});
export type WorktreeInventory = typeof WorktreeInventory.Type;

export const WorktreeMutation = Schema.Struct({
  ...WorktreeContext.fields,
  operationId: Path,
  path: Path,
  expectedIdentity: Path,
  expectedHead: Schema.NullOr(Schema.String),
  expectedBranch: Schema.NullOr(Schema.String),
});
export type WorktreeMutation = typeof WorktreeMutation.Type;

export const WorktreeSelection = Schema.Struct({
  ...WorktreeContext.fields,
  threadId: ThreadId,
  commandId: Path,
  expectedPath: Schema.NullOr(Path),
  path: Path,
  expectedIdentity: Path,
});
export type WorktreeSelection = typeof WorktreeSelection.Type;

export const WorktreeOperationResult = Schema.Struct({
  operationId: Path,
  path: Path,
  status: Schema.Literals(["completed", "recovery-required"]),
});
export type WorktreeOperationResult = typeof WorktreeOperationResult.Type;

export const WorktreeOperationSummary = Schema.Struct({
  operationId: Path,
  kind: Schema.Literals(["create", "rename", "delete", "access"]),
  source: Path,
  destination: Path,
  phase: Schema.Literals([
    "prepared",
    "dispatched",
    "moved",
    "references",
    "completed",
    "rejected",
    "recovery-required",
  ]),
  error: Schema.NullOr(Schema.String),
  canRecheck: Schema.Boolean,
});
export type WorktreeOperationSummary = typeof WorktreeOperationSummary.Type;
export const WorktreeOperationRecovery = Schema.Struct({
  ...WorktreeContext.fields,
  operationId: Path,
});
export type WorktreeOperationRecovery = typeof WorktreeOperationRecovery.Type;
