import { type AutomationSchedule } from "@bigbud/contracts";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";

import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SchedulerConfig } from "../Services/SchedulerConfig.ts";
import {
  SchedulerReactor,
  type AutomationTriggerResult,
  type SchedulerReactorShape,
} from "../Services/SchedulerReactor.ts";
import {
  computeNextRunAt,
  dispatchAutomationRun,
  makeCommandId,
  makeMessageId,
  makeRunId,
  readScheduleDispatchContext,
} from "./SchedulerReactor.logic.ts";
import {
  handleAutomationTerminalEvent,
  makeLoadScheduleKind,
  reconcileFromConfig,
} from "./SchedulerReactor.reconcile.ts";

const makeSchedulerReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const repository = yield* AutomationScheduleRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const config = yield* SchedulerConfig;

  const leaseDurationMs = Duration.toMillis(config.leaseDuration);
  const loadScheduleKind = makeLoadScheduleKind(repository);

  const processClaimedSchedule = Effect.fn("processClaimedSchedule")(function* (
    schedule: AutomationSchedule,
  ) {
    const scheduledFor = schedule.nextRunAt;
    if (scheduledFor === null) {
      return;
    }

    const now = new Date().toISOString();
    const nextRunResult = yield* computeNextRunAt({
      scheduleKind: schedule.scheduleKind,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone,
      now,
    });

    if (!nextRunResult.ok) {
      yield* repository
        .pause({
          automationId: schedule.automationId,
          pausedAt: now,
          updatedAt: now,
        })
        .pipe(Effect.ignore);
      yield* repository.releaseLease({
        automationId: schedule.automationId,
        updatedAt: now,
      });
      return;
    }

    const runOption = yield* repository.claimOccurrence({
      automationId: schedule.automationId,
      scheduledFor,
      nextRunAt: nextRunResult.nextRunAt,
      runId: makeRunId(),
      threadId: schedule.targetThreadId,
      messageId: makeMessageId(),
      commandId: makeCommandId(),
      startedAt: now,
      updatedAt: now,
    });

    if (Option.isNone(runOption)) {
      yield* repository.releaseLease({
        automationId: schedule.automationId,
        updatedAt: now,
      });
      return;
    }

    const dispatchContext = readScheduleDispatchContext(schedule);
    const dispatchResult = yield* dispatchAutomationRun({
      repository,
      orchestrationEngine,
      run: runOption.value,
      prompt: dispatchContext.prompt,
      scheduleKind: dispatchContext.scheduleKind,
      automationId: dispatchContext.automationId,
    });

    if (!dispatchResult.ok && !dispatchResult.skipped && schedule.scheduleKind === "custom") {
      yield* repository
        .updateNextRun({
          automationId: schedule.automationId,
          nextRunAt: scheduledFor,
          updatedAt: now,
        })
        .pipe(Effect.ignore);
    }
  });

  const dispatchManualRun = Effect.fn("dispatchManualRun")(function* (
    schedule: AutomationSchedule,
  ) {
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
      triggerKind: "manual",
      scheduledFor: null,
      startedAt: now,
    });

    const dispatchResult = yield* dispatchAutomationRun({
      repository,
      orchestrationEngine,
      run: {
        runId,
        automationId: schedule.automationId,
        threadId: schedule.targetThreadId,
        messageId,
        commandId,
        triggerKind: "manual",
        scheduledFor: null,
        status: "started",
        startedAt: now,
        dispatchedAt: null,
        finishedAt: null,
        providerTerminalEventId: null,
        errorMessage: null,
      },
      prompt: schedule.prompt,
      scheduleKind: schedule.scheduleKind,
      automationId: schedule.automationId,
    });

    return dispatchResult.ok
      ? ({ status: "dispatched", triggeredAt: now, runId } satisfies AutomationTriggerResult)
      : ({ status: "dispatch_failed" } satisfies AutomationTriggerResult);
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
        processClaimedSchedule(schedule).pipe(
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

    yield* reconcileFromConfig({
      repository,
      projectionTurnRepository,
      orchestrationEngine,
      config,
    }).pipe(Effect.ignore);

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

    yield* Effect.forkScoped(
      Effect.repeat(
        reconcileFromConfig({
          repository,
          projectionTurnRepository,
          orchestrationEngine,
          config,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("automation reconciliation failed", { cause: cause.toString() }),
          ),
        ),
        Schedule.fixed(config.reconcileInterval),
      ),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        handleAutomationTerminalEvent({
          repository,
          projectionTurnRepository,
          event,
          loadScheduleKind,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("automation terminal event handling failed", {
              eventType: event.type,
              cause: cause.toString(),
            }),
          ),
        ),
      ),
    );
  });

  const triggerNow: SchedulerReactorShape["triggerNow"] = Effect.fn("triggerNow")(
    function* (automationId) {
      const scheduleOption = yield* repository
        .getById({ automationId })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(scheduleOption) || scheduleOption.value.deletedAt !== null) {
        return { status: "not_found" } satisfies AutomationTriggerResult;
      }

      const schedule = scheduleOption.value;

      return yield* dispatchManualRun(schedule).pipe(
        Effect.catch(() =>
          Effect.succeed({ status: "dispatch_failed" } satisfies AutomationTriggerResult),
        ),
      );
    },
  );

  return {
    start,
    triggerNow,
  } satisfies SchedulerReactorShape;
});

export const SchedulerReactorLive = Layer.effect(SchedulerReactor, makeSchedulerReactor).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);

export const DefaultSchedulerConfigLive = Layer.succeed(SchedulerConfig, {
  tickInterval: Duration.seconds(5),
  leaseDuration: Duration.minutes(5),
  claimBatchSize: 10,
  maxConcurrency: 3,
  staleRunTimeout: Duration.hours(2),
  reconcileInterval: Duration.seconds(30),
  reconcileBatchSize: 50,
});
