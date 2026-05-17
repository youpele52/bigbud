import { Schema } from "effect";
import { NonNegativeInt } from "../core/baseSchemas";
import { GitActionProgressPhase, GitActionProgressStream, GitStackedAction } from "./git.domain";
import { GitRunStackedActionResult } from "./git.results";
import { TrimmedNonEmptyStringSchema } from "./git.shared";

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
