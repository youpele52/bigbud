import {
  AutomationId,
  AutomationRunId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
} from "@bigbud/contracts";
import { Data, Duration, Effect, Layer, Option, Schedule } from "effect";

import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SchedulerConfig } from "../Services/SchedulerConfig.ts";
import { SchedulerReactor, type SchedulerReactorShape } from "../Services/SchedulerReactor.ts";
import { getNextCronTime } from "../Scheduler/cron.ts";

function makeCommandId(): CommandId {
  return CommandId.makeUnsafe(`server:automation:${crypto.randomUUID()}`);
}

function makeMessageId(): MessageId {
  return MessageId.makeUnsafe(crypto.randomUUID());
}

function makeRunId(): AutomationRunId {
  return AutomationRunId.makeUnsafe(crypto.randomUUID());
}

class AutomationCronError extends Data.TaggedError("AutomationCronError")<{
  readonly message: string;
}> {}

const makeSchedulerReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const repository = yield* AutomationScheduleRepository;
  const config = yield* SchedulerConfig;

  const leaseDurationMs = Duration.toMillis(config.leaseDuration);

  const dispatchSchedule = Effect.fn("dispatchSchedule")(function* (schedule: {
    readonly automationId: AutomationId;
    readonly targetThreadId: ThreadId;
    readonly prompt: string;
    readonly cronExpression: string;
    readonly timezone: string;
  }) {
    const now = new Date().toISOString();
    const runId = makeRunId();
    const messageId = makeMessageId();
    const commandId = makeCommandId();

    yield* repository.recordRunStarted({
      runId,
      automationId: schedule.automationId,
      threadId: schedule.targetThreadId,
      messageId,
      commandId,
      startedAt: now,
    });

    const dispatchResult = yield* Effect.matchEffect(
      orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: schedule.targetThreadId,
        message: {
          messageId,
          role: "user",
          text: schedule.prompt,
          attachments: [],
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
      {
        onFailure: () => Effect.succeed({ ok: false as const }),
        onSuccess: () => Effect.succeed({ ok: true as const }),
      },
    );

    const nextRunResult = yield* Effect.matchEffect(
      Effect.try({
        try: () => getNextCronTime(schedule.cronExpression, new Date(now), schedule.timezone),
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

    if (!nextRunResult.ok) {
      yield* repository.recordRunFailed({
        runId,
        finishedAt: new Date().toISOString(),
        errorMessage: nextRunResult.error,
      });
      yield* repository
        .pause({
          automationId: schedule.automationId,
          pausedAt: now,
          updatedAt: new Date().toISOString(),
        })
        .pipe(Effect.ignore);
      return;
    }

    if (!dispatchResult.ok) {
      yield* repository.recordRunFailed({
        runId,
        finishedAt: new Date().toISOString(),
        errorMessage: "Failed to dispatch automation turn",
      });
    } else {
      yield* repository.recordRunFinished({
        runId,
        finishedAt: new Date().toISOString(),
      });
    }

    yield* repository.updateNextRun({
      automationId: schedule.automationId,
      nextRunAt: nextRunResult.nextRunAt,
      updatedAt: new Date().toISOString(),
    });
  });

  const tick = Effect.fn("tick")(function* () {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + leaseDurationMs).toISOString();

    const dueSchedules = yield* repository.claimDue({
      now,
      leaseUntil,
      limit: config.claimBatchSize,
    });
    if (dueSchedules.length === 0) {
      return;
    }

    yield* Effect.logDebug("scheduler tick: dispatching due automations", {
      count: dueSchedules.length,
    });

    yield* Effect.forEach(
      dueSchedules,
      (schedule) =>
        dispatchSchedule(schedule).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("automation dispatch failed", {
              automationId: schedule.automationId,
              cause: cause.toString(),
            }),
          ),
        ),
      { concurrency: config.maxConcurrency },
    );
  });

  const start: SchedulerReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.logDebug("scheduler reactor starting");

    yield* Effect.forkScoped(
      Effect.repeat(
        tick().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("scheduler tick failed", { cause: cause.toString() }),
          ),
        ),
        Schedule.fixed(config.tickInterval),
      ),
    );
  });

  const triggerNow: SchedulerReactorShape["triggerNow"] = Effect.fn("triggerNow")(
    function* (automationId) {
      yield* repository.getById({ automationId }).pipe(
        Effect.flatMap((scheduleOption) => {
          if (Option.isNone(scheduleOption) || scheduleOption.value.deletedAt !== null) {
            return Effect.void;
          }
          return dispatchSchedule(scheduleOption.value);
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("automation trigger failed", {
            automationId,
            cause: cause.toString(),
          }),
        ),
      );
    },
  );

  return {
    start,
    triggerNow,
  } satisfies SchedulerReactorShape;
});

export const SchedulerReactorLive = Layer.effect(SchedulerReactor, makeSchedulerReactor);

export const DefaultSchedulerConfigLive = Layer.succeed(SchedulerConfig, {
  tickInterval: Duration.seconds(60),
  leaseDuration: Duration.minutes(5),
  claimBatchSize: 10,
  maxConcurrency: 3,
});
