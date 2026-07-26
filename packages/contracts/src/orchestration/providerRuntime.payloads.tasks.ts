import { Schema } from "effect";

import { NonNegativeInt, RuntimeTaskId, TurnId } from "../core/baseSchemas";
import { OrchestrationTaskFreshness, OrchestrationTaskSource } from "./orchestration.thread";
import { TrimmedNonEmptyStringSchema } from "./providerRuntime.primitives";

export const TaskStartedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  taskType: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskStartedPayload = typeof TaskStartedPayload.Type;

export const TaskProgressPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: TrimmedNonEmptyStringSchema,
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  lastToolName: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskProgressPayload = typeof TaskProgressPayload.Type;

export const TaskCompletedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
});
export type TaskCompletedPayload = typeof TaskCompletedPayload.Type;

export const TaskUpdatedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.Literals(["pending", "inProgress", "completed", "failed", "stopped"]),
  subject: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  activeLabel: Schema.optional(TrimmedNonEmptyStringSchema),
  sourceToolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  requestId: Schema.optional(TrimmedNonEmptyStringSchema),
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentAgentId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentToolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentTaskId: Schema.optional(RuntimeTaskId),
  subagentType: Schema.optional(TrimmedNonEmptyStringSchema),
  background: Schema.optional(Schema.Boolean),
  blockedBy: Schema.optional(Schema.Array(RuntimeTaskId)),
  progressSummary: Schema.optional(TrimmedNonEmptyStringSchema),
  lastToolName: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  terminalReason: Schema.optional(TrimmedNonEmptyStringSchema),
  source: OrchestrationTaskSource.pipe(Schema.withDecodingDefault(() => "lifecycle")),
  freshness: OrchestrationTaskFreshness.pipe(
    Schema.withDecodingDefault(() => ({
      sessionEpoch: "legacy",
      sourcePriority: 0,
      observedOrdinal: 0,
    })),
  ),
  createdAt: Schema.optional(Schema.String),
  turnId: Schema.optional(TurnId),
  order: Schema.optional(NonNegativeInt),
  membership: Schema.optional(
    Schema.Struct({
      taskList: Schema.Boolean,
      background: Schema.Boolean,
      observed: Schema.Boolean,
      legacy: Schema.Boolean,
    }),
  ),
});
export type TaskUpdatedPayload = typeof TaskUpdatedPayload.Type;

/** Explicit durable deletion after an authoritative membership replacement. */
export const TaskRemovedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  source: OrchestrationTaskSource,
  freshness: OrchestrationTaskFreshness,
  replacement: Schema.optional(Schema.Literals(["snapshot", "explicit"])),
});
export type TaskRemovedPayload = typeof TaskRemovedPayload.Type;
