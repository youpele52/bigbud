import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  RuntimeTaskId,
  TrimmedNonEmptyString,
  TurnId,
} from "../core/baseSchemas";

export const OrchestrationTaskStatus = Schema.Literals([
  "pending",
  "inProgress",
  "completed",
  "failed",
  "stopped",
]);
export type OrchestrationTaskStatus = typeof OrchestrationTaskStatus.Type;

/** The source whose observed membership currently keeps a modern task visible. */
export const OrchestrationTaskSource = Schema.Literals([
  "lifecycle",
  "taskList",
  "background",
  "observed",
]);
export type OrchestrationTaskSource = typeof OrchestrationTaskSource.Type;

/** Explicit classification. Legacy and ambiguous records remain ordinary tasks. */
export const OrchestrationTaskKind = Schema.Literals(["task", "providerSubagent"]);
export type OrchestrationTaskKind = typeof OrchestrationTaskKind.Type;

/** Additive ordering data; legacy snapshots decode into the deterministic legacy epoch. */
export const OrchestrationTaskFreshness = Schema.Struct({
  sessionEpoch: Schema.String.pipe(Schema.withDecodingDefault(() => "legacy")),
  sourcePriority: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 0)),
  snapshotGeneration: Schema.optional(NonNegativeInt),
  providerRevision: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  providerMessageId: Schema.optional(TrimmedNonEmptyString),
  providerTimestamp: Schema.optional(IsoDateTime),
  observedOrdinal: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 0)),
});
export type OrchestrationTaskFreshness = typeof OrchestrationTaskFreshness.Type;

/** Provider-neutral durable task state, including optional subagent relationships. */
export const OrchestrationTaskMembership = Schema.Struct({
  taskList: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  background: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  observed: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  legacy: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type OrchestrationTaskMembership = typeof OrchestrationTaskMembership.Type;

/** Most recent tool steps kept per provider subagent. */
export const ORCHESTRATION_SUBAGENT_RECENT_STEPS_MAX = 5;

export const OrchestrationSubagentStepStatus = Schema.Literals(["running", "completed", "failed"]);
export type OrchestrationSubagentStepStatus = typeof OrchestrationSubagentStepStatus.Type;

/** One bounded tool step of a provider subagent. `id` is the native tool-use ID when known. */
export const OrchestrationSubagentStep = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  toolName: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
  status: OrchestrationSubagentStepStatus,
  at: IsoDateTime,
});
export type OrchestrationSubagentStep = typeof OrchestrationSubagentStep.Type;

/** Provider-reported subagent totals. Absent values are unknown, never zero-filled. */
export const OrchestrationSubagentMetrics = Schema.Struct({
  totalTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  costUsd: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type OrchestrationSubagentMetrics = typeof OrchestrationSubagentMetrics.Type;

/** Additive provider-subagent display fields shared by task snapshots and runtime updates. */
export const OrchestrationSubagentFields = {
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  depth: Schema.optional(NonNegativeInt),
  endedAt: Schema.optional(IsoDateTime),
  resultSummary: Schema.optional(TrimmedNonEmptyString),
  metrics: Schema.optional(OrchestrationSubagentMetrics),
  recentSteps: Schema.optional(
    Schema.Array(OrchestrationSubagentStep).check(
      Schema.isMaxLength(ORCHESTRATION_SUBAGENT_RECENT_STEPS_MAX),
    ),
  ),
};

export const OrchestrationTask = Schema.Struct({
  id: RuntimeTaskId,
  kind: Schema.optional(OrchestrationTaskKind),
  nativeId: Schema.optional(TrimmedNonEmptyString),
  activityFresh: Schema.optional(Schema.Boolean),
  status: OrchestrationTaskStatus,
  subject: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  activeLabel: Schema.optional(TrimmedNonEmptyString),
  sourceToolUseId: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(TrimmedNonEmptyString),
  agentId: Schema.optional(TrimmedNonEmptyString),
  parentAgentId: Schema.optional(TrimmedNonEmptyString),
  parentToolUseId: Schema.optional(TrimmedNonEmptyString),
  parentTaskId: Schema.optional(RuntimeTaskId),
  subagentType: Schema.optional(TrimmedNonEmptyString),
  background: Schema.optional(Schema.Boolean),
  blockedBy: Schema.optional(Schema.Array(RuntimeTaskId)),
  progressSummary: Schema.optional(TrimmedNonEmptyString),
  lastToolName: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(Schema.Unknown),
  terminalReason: Schema.optional(TrimmedNonEmptyString),
  ...OrchestrationSubagentFields,
  turnId: Schema.optional(TurnId),
  order: Schema.optional(NonNegativeInt),
  membership: Schema.optional(OrchestrationTaskMembership),
  source: OrchestrationTaskSource.pipe(Schema.withDecodingDefault(() => "lifecycle")),
  freshness: OrchestrationTaskFreshness.pipe(
    Schema.withDecodingDefault(() => ({
      sessionEpoch: "legacy",
      sourcePriority: 0,
      observedOrdinal: 0,
    })),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationTask = typeof OrchestrationTask.Type;
