import {
  AutomationId,
  AutomationRun,
  AutomationRunId,
  AutomationSchedule,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  MessageId,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { Data, Effect } from "effect";

import type { AutomationScheduleRepositoryShape } from "../../persistence/Services/AutomationScheduleRepository.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { getNextCronTime } from "../Scheduler/cron.ts";

export class AutomationCronError extends Data.TaggedError("AutomationCronError")<{
  readonly message: string;
}> {}

export function makeCommandId(): CommandId {
  return CommandId.makeUnsafe(`server:automation:${crypto.randomUUID()}`);
}

export function makeMessageId(): MessageId {
  return MessageId.makeUnsafe(crypto.randomUUID());
}

export function makeRunId(): AutomationRunId {
  return AutomationRunId.makeUnsafe(crypto.randomUUID());
}

export function buildAutomationExecutionPrompt(prompt: string, now: string): string {
  return [
    "[Automated scheduled task]",
    `Triggered at: ${now}`,
    "Execute the following task immediately without asking for clarification.",
    "",
    prompt,
  ].join("\n");
}

export const computeNextRunAt = Effect.fn("computeNextRunAt")(function* (schedule: {
  readonly scheduleKind: "custom" | "once";
  readonly cronExpression: string;
  readonly timezone: string;
  readonly now: string;
}) {
  if (schedule.scheduleKind === "once") {
    return { ok: true as const, nextRunAt: null };
  }

  return yield* Effect.matchEffect(
    Effect.try({
      try: () =>
        getNextCronTime(schedule.cronExpression, new Date(schedule.now), schedule.timezone),
      catch: (error) =>
        new AutomationCronError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
    {
      onFailure: (error) =>
        Effect.succeed({
          ok: false as const,
          error: error.message,
        }),
      onSuccess: (date) => Effect.succeed({ ok: true as const, nextRunAt: date.toISOString() }),
    },
  );
});

export const dispatchAutomationRun = Effect.fn("dispatchAutomationRun")(function* (input: {
  readonly repository: AutomationScheduleRepositoryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly run: AutomationRun;
  readonly prompt: string;
  readonly scheduleKind: "custom" | "once";
  readonly automationId: AutomationId;
}) {
  if (input.run.dispatchedAt !== null) {
    return { ok: true as const, skipped: true as const };
  }

  const now = new Date().toISOString();
  const executionPrompt = buildAutomationExecutionPrompt(input.prompt, input.run.startedAt);
  const readModel = yield* input.orchestrationEngine.getReadModel();
  const thread = readModel.threads.find((entry) => entry.id === input.run.threadId);

  const dispatchResult = yield* Effect.matchEffect(
    input.orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: input.run.commandId,
      threadId: input.run.threadId,
      message: {
        messageId: input.run.messageId,
        role: "user",
        text: executionPrompt,
        attachments: [],
      },
      ...(thread?.modelSelection !== undefined ? { modelSelection: thread.modelSelection } : {}),
      runtimeMode: thread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode: thread?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    }),
    {
      onFailure: () => Effect.succeed({ ok: false as const }),
      onSuccess: () => Effect.succeed({ ok: true as const }),
    },
  );

  if (!dispatchResult.ok) {
    yield* input.repository.recordRunFailed({
      runId: input.run.runId,
      finishedAt: now,
      errorMessage: "Failed to dispatch automation turn",
    });
    if (input.scheduleKind === "once") {
      yield* input.repository
        .pause({
          automationId: input.automationId,
          pausedAt: now,
          updatedAt: now,
        })
        .pipe(Effect.ignore);
    }
    return { ok: false as const, skipped: false as const };
  }

  yield* input.repository.recordRunDispatched({
    runId: input.run.runId,
    dispatchedAt: now,
  });

  return { ok: true as const, skipped: false as const };
});

export const completeAutomationRun = Effect.fn("completeAutomationRun")(function* (input: {
  readonly repository: AutomationScheduleRepositoryShape;
  readonly run: AutomationRun;
  readonly scheduleKind: "custom" | "once";
  readonly success: boolean;
  readonly errorMessage?: string;
  readonly providerTerminalEventId?: EventId;
}) {
  const finishedAt = new Date().toISOString();
  if (input.success) {
    yield* input.repository.recordRunFinished({
      runId: input.run.runId,
      finishedAt,
      ...(input.providerTerminalEventId !== undefined
        ? { providerTerminalEventId: input.providerTerminalEventId }
        : {}),
    });
    if (input.scheduleKind === "once") {
      yield* input.repository.complete({
        automationId: input.run.automationId,
        completedAt: finishedAt,
        updatedAt: finishedAt,
      });
    }
    return;
  }

  yield* input.repository.recordRunFailed({
    runId: input.run.runId,
    finishedAt,
    errorMessage: input.errorMessage ?? "Automation turn failed",
  });
  if (input.scheduleKind === "once") {
    yield* input.repository
      .pause({
        automationId: input.run.automationId,
        pausedAt: finishedAt,
        updatedAt: finishedAt,
      })
      .pipe(Effect.ignore);
  }
});

export function isAutomationTerminalEvent(
  event: OrchestrationEvent,
): event is Extract<
  OrchestrationEvent,
  { readonly type: "thread.turn-diff-completed" | "thread.message-sent" }
> {
  return event.type === "thread.turn-diff-completed" || event.type === "thread.message-sent";
}

export function readScheduleDispatchContext(schedule: AutomationSchedule) {
  return {
    automationId: schedule.automationId,
    targetThreadId: schedule.targetThreadId,
    prompt: schedule.prompt,
    scheduleKind: schedule.scheduleKind,
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
  };
}

export type ScheduleDispatchContext = ReturnType<typeof readScheduleDispatchContext>;
