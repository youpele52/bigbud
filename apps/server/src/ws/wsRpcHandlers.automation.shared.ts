import { Effect, Schema } from "effect";
import { ServerAutomationError } from "@bigbud/contracts";

import { getNextCronTime } from "../orchestration/Scheduler/cron.ts";
import { AutomationScheduleNotFoundError } from "../persistence/Errors.ts";

export const DEFAULT_AUTOMATION_TIMEZONE = "UTC";

export function toAutomationError(cause: unknown, message: string) {
  if (Schema.is(AutomationScheduleNotFoundError)(cause)) {
    return new ServerAutomationError({
      message: "Automation not found",
    });
  }
  return Schema.is(ServerAutomationError)(cause)
    ? cause
    : new ServerAutomationError({
        message,
        cause,
      });
}

export function resolveNextRunAt(input: {
  readonly cronExpression: string;
  readonly runAt?: string | null;
  readonly scheduleKind: "custom" | "once";
  readonly timezone: string;
  readonly now: Date;
}) {
  if (input.scheduleKind === "once") {
    if (!input.runAt) {
      return Effect.fail(
        new ServerAutomationError({
          message: "One-time automations must include a run time",
        }),
      );
    }

    const runAtMs = Date.parse(input.runAt);
    if (Number.isNaN(runAtMs)) {
      return Effect.fail(
        new ServerAutomationError({
          message: "One-time automations must include a valid run time",
        }),
      );
    }

    if (runAtMs <= input.now.getTime()) {
      return Effect.fail(
        new ServerAutomationError({
          message: "One-time automations must be scheduled in the future",
        }),
      );
    }

    return Effect.succeed(input.runAt);
  }

  return Effect.try({
    try: () => getNextCronTime(input.cronExpression, input.now, input.timezone).toISOString(),
    catch: (cause) =>
      new ServerAutomationError({
        message: cause instanceof Error ? cause.message : "Invalid automation schedule",
        cause,
      }),
  });
}
