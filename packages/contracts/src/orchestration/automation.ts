import { Schema } from "effect";
import {
  AutomationId,
  AutomationRunId,
  CommandId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";

export const AutomationScheduleStatus = Schema.Literals([
  "active",
  "completed",
  "paused",
  "deleted",
]);
export type AutomationScheduleStatus = typeof AutomationScheduleStatus.Type;

export const AutomationRunStatus = Schema.Literals(["started", "finished", "failed"]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

export const AutomationSchedule = Schema.Struct({
  automationId: AutomationId,
  projectId: ProjectId,
  targetThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  scheduleKind: Schema.Literals(["custom", "once"]),
  scheduleLabel: TrimmedNonEmptyString,
  cronExpression: TrimmedNonEmptyString,
  timezone: TrimmedNonEmptyString,
  runAt: Schema.NullOr(IsoDateTime),
  nextRunAt: Schema.NullOr(IsoDateTime),
  pausedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AutomationSchedule = typeof AutomationSchedule.Type;

export const AutomationRun = Schema.Struct({
  runId: AutomationRunId,
  automationId: AutomationId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  status: AutomationRunStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  errorMessage: Schema.NullOr(TrimmedNonEmptyString),
});
export type AutomationRun = typeof AutomationRun.Type;
