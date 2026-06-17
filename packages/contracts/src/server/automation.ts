import { Schema } from "effect";

import { AutomationRun, AutomationSchedule } from "../orchestration/automation";
import {
  AutomationId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";

export const ServerListAutomationsInput = Schema.Struct({
  projectId: ProjectId,
});
export type ServerListAutomationsInput = typeof ServerListAutomationsInput.Type;

export const ServerListAutomationsResult = Schema.Struct({
  automations: Schema.Array(AutomationSchedule),
});
export type ServerListAutomationsResult = typeof ServerListAutomationsResult.Type;

export const ServerListAllAutomationsInput = Schema.Struct({});
export type ServerListAllAutomationsInput = typeof ServerListAllAutomationsInput.Type;

export const ServerListAllAutomationsResult = ServerListAutomationsResult;
export type ServerListAllAutomationsResult = typeof ServerListAllAutomationsResult.Type;

export const ServerGetAutomationInput = Schema.Struct({
  automationId: AutomationId,
});
export type ServerGetAutomationInput = typeof ServerGetAutomationInput.Type;

export const ServerGetAutomationResult = Schema.Struct({
  automation: AutomationSchedule,
});
export type ServerGetAutomationResult = typeof ServerGetAutomationResult.Type;

export const ServerCreateAutomationInput = Schema.Struct({
  projectId: ProjectId,
  targetThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  scheduleKind: Schema.Literals(["custom", "once"]),
  scheduleLabel: TrimmedNonEmptyString,
  cronExpression: TrimmedNonEmptyString,
  timezone: Schema.optional(TrimmedNonEmptyString),
  runAt: Schema.optional(IsoDateTime),
});
export type ServerCreateAutomationInput = typeof ServerCreateAutomationInput.Type;

export const ServerUpdateAutomationInput = Schema.Struct({
  automationId: AutomationId,
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  scheduleKind: Schema.optional(Schema.Literals(["custom", "once"])),
  scheduleLabel: Schema.optional(TrimmedNonEmptyString),
  cronExpression: Schema.optional(TrimmedNonEmptyString),
  timezone: Schema.optional(TrimmedNonEmptyString),
  runAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type ServerUpdateAutomationInput = typeof ServerUpdateAutomationInput.Type;

export const ServerPauseAutomationInput = Schema.Struct({
  automationId: AutomationId,
});
export type ServerPauseAutomationInput = typeof ServerPauseAutomationInput.Type;

export const ServerResumeAutomationInput = Schema.Struct({
  automationId: AutomationId,
});
export type ServerResumeAutomationInput = typeof ServerResumeAutomationInput.Type;

export const ServerDeleteAutomationInput = Schema.Struct({
  automationId: AutomationId,
});
export type ServerDeleteAutomationInput = typeof ServerDeleteAutomationInput.Type;

export const ServerTriggerAutomationInput = Schema.Struct({
  automationId: AutomationId,
});
export type ServerTriggerAutomationInput = typeof ServerTriggerAutomationInput.Type;

export const ServerAutomationResult = Schema.Struct({
  automation: AutomationSchedule,
});
export type ServerAutomationResult = typeof ServerAutomationResult.Type;

export const ServerListAutomationRunsInput = Schema.Struct({
  automationId: AutomationId,
  limit: Schema.optional(Schema.Number),
});
export type ServerListAutomationRunsInput = typeof ServerListAutomationRunsInput.Type;

export const ServerListAutomationRunsResult = Schema.Struct({
  runs: Schema.Array(AutomationRun),
});
export type ServerListAutomationRunsResult = typeof ServerListAutomationRunsResult.Type;

export const ServerTriggerAutomationResult = Schema.Struct({
  triggeredAt: IsoDateTime,
});
export type ServerTriggerAutomationResult = typeof ServerTriggerAutomationResult.Type;

export class ServerAutomationError extends Schema.TaggedErrorClass<ServerAutomationError>()(
  "ServerAutomationError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
