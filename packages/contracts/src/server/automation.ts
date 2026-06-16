import { Schema } from "effect";

import { AutomationRun, AutomationSchedule } from "../orchestration/automation";
import { AutomationId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";

export const ServerListAutomationsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ServerListAutomationsInput = typeof ServerListAutomationsInput.Type;

export const ServerListAutomationsResult = Schema.Struct({
  automations: Schema.Array(AutomationSchedule),
});
export type ServerListAutomationsResult = typeof ServerListAutomationsResult.Type;

export const ServerCreateAutomationInput = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  cronExpression: TrimmedNonEmptyString,
  timezone: Schema.optional(TrimmedNonEmptyString),
});
export type ServerCreateAutomationInput = typeof ServerCreateAutomationInput.Type;

export const ServerUpdateAutomationInput = Schema.Struct({
  automationId: AutomationId,
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  cronExpression: Schema.optional(TrimmedNonEmptyString),
  timezone: Schema.optional(TrimmedNonEmptyString),
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
