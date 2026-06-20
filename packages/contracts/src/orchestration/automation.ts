import { Schema } from "effect";
import {
  AutomationId,
  AutomationRunId,
  CommandId,
  EventId,
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

export const AutomationRunTriggerKind = Schema.Literals(["scheduled", "manual"]);
export type AutomationRunTriggerKind = typeof AutomationRunTriggerKind.Type;

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
  triggerKind: AutomationRunTriggerKind,
  scheduledFor: Schema.NullOr(IsoDateTime),
  status: AutomationRunStatus,
  startedAt: IsoDateTime,
  dispatchedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  providerTerminalEventId: Schema.NullOr(EventId),
  errorMessage: Schema.NullOr(TrimmedNonEmptyString),
});
export type AutomationRun = typeof AutomationRun.Type;
