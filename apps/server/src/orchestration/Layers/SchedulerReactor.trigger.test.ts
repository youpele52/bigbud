import { AutomationId, ProjectId, ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { Duration, Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomationScheduleRepositoryLive } from "../../persistence/Layers/AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationListenerCallbackError } from "../Errors.ts";
import { SchedulerConfig } from "../Services/SchedulerConfig.ts";
import { SchedulerReactor } from "../Services/SchedulerReactor.ts";
import { SchedulerReactorLive } from "./SchedulerReactor.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";

function makeTriggerTestLayer(dispatch: OrchestrationEngineShape["dispatch"]) {
  return Layer.empty.pipe(
    Layer.provideMerge(SchedulerReactorLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(AutomationScheduleRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(SchedulerConfig, {
        tickInterval: Duration.seconds(5),
        leaseDuration: Duration.minutes(5),
        claimBatchSize: 10,
        maxConcurrency: 2,
        staleRunTimeout: Duration.minutes(30),
        reconcileInterval: Duration.minutes(5),
        reconcileBatchSize: 10,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        getReadModel: () => Effect.succeed(createEmptyReadModel(new Date().toISOString())),
        readEvents: () => Stream.fromIterable([] as ReadonlyArray<OrchestrationEvent>),
        dispatch: (command) => dispatch(command),
        streamDomainEvents: Stream.fromIterable([] as ReadonlyArray<OrchestrationEvent>),
      }),
    ),
  );
}

describe("SchedulerReactor triggerNow", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    SchedulerReactor | AutomationScheduleRepository,
    unknown
  > | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("returns not_found for missing automations", async () => {
    runtime = ManagedRuntime.make(makeTriggerTestLayer(() => Effect.succeed({ sequence: 1 })));
    const reactor = await runtime.runPromise(Effect.service(SchedulerReactor));

    const result = await runtime.runPromise(
      reactor.triggerNow(AutomationId.makeUnsafe("missing-trigger")),
    );

    expect(result.status).toBe("not_found");
  });

  it("dispatches manual runs for paused automations", async () => {
    runtime = ManagedRuntime.make(makeTriggerTestLayer(() => Effect.succeed({ sequence: 1 })));
    const repository = await runtime.runPromise(Effect.service(AutomationScheduleRepository));
    const reactor = await runtime.runPromise(Effect.service(SchedulerReactor));
    const automationId = AutomationId.makeUnsafe("auto-trigger-paused");

    await runtime.runPromise(
      repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-trigger-paused"),
        targetThreadId: ThreadId.makeUnsafe("thread-trigger-paused"),
        title: "Paused",
        prompt: "Run manually while paused",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      }),
    );
    await runtime.runPromise(
      repository.pause({
        automationId,
        pausedAt: "2026-06-16T09:00:00.000Z",
        updatedAt: "2026-06-16T09:00:00.000Z",
      }),
    );

    const result = await runtime.runPromise(reactor.triggerNow(automationId));
    expect(result.status).toBe("dispatched");

    const schedule = await runtime.runPromise(repository.getById({ automationId }));
    expect(Option.isSome(schedule)).toBe(true);
    if (Option.isSome(schedule)) {
      expect(schedule.value.pausedAt).not.toBeNull();
    }
  });

  it("returns paused_or_completed for completed automations", async () => {
    runtime = ManagedRuntime.make(makeTriggerTestLayer(() => Effect.succeed({ sequence: 1 })));
    const repository = await runtime.runPromise(Effect.service(AutomationScheduleRepository));
    const reactor = await runtime.runPromise(Effect.service(SchedulerReactor));
    const automationId = AutomationId.makeUnsafe("auto-trigger-completed");

    await runtime.runPromise(
      repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-trigger-completed"),
        targetThreadId: ThreadId.makeUnsafe("thread-trigger-completed"),
        title: "Completed",
        prompt: "Already finished",
        scheduleKind: "once",
        scheduleLabel: "Once",
        cronExpression: "@once",
        timezone: "UTC",
        runAt: "2026-06-16T10:00:00.000Z",
        nextRunAt: "2026-06-16T10:00:00.000Z",
      }),
    );
    await runtime.runPromise(
      repository.complete({
        automationId,
        completedAt: "2026-06-16T11:00:00.000Z",
        updatedAt: "2026-06-16T11:00:00.000Z",
      }),
    );

    const result = await runtime.runPromise(reactor.triggerNow(automationId));
    expect(result.status).toBe("paused_or_completed");
  });

  it("returns dispatched and records a manual run without changing nextRunAt", async () => {
    const nextRunAt = "2026-06-16T12:00:00.000Z";
    runtime = ManagedRuntime.make(makeTriggerTestLayer(() => Effect.succeed({ sequence: 1 })));
    const repository = await runtime.runPromise(Effect.service(AutomationScheduleRepository));
    const reactor = await runtime.runPromise(Effect.service(SchedulerReactor));
    const automationId = AutomationId.makeUnsafe("auto-trigger-success");

    await runtime.runPromise(
      repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-trigger-success"),
        targetThreadId: ThreadId.makeUnsafe("thread-trigger-success"),
        title: "Manual",
        prompt: "Run manually",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt,
      }),
    );

    const result = await runtime.runPromise(reactor.triggerNow(automationId));
    expect(result.status).toBe("dispatched");
    expect(result.runId).toBeDefined();

    const schedule = await runtime.runPromise(repository.getById({ automationId }));
    expect(Option.isSome(schedule)).toBe(true);
    if (Option.isSome(schedule)) {
      expect(schedule.value.nextRunAt).toBe(nextRunAt);
    }

    const runs = await runtime.runPromise(repository.listRuns({ automationId, limit: 10 }));
    expect(runs.length).toBe(1);
    expect(runs[0]?.triggerKind).toBe("manual");
    expect(runs[0]?.scheduledFor).toBeNull();
    expect(runs[0]?.dispatchedAt).not.toBeNull();
  });

  it("returns dispatch_failed when orchestration dispatch fails", async () => {
    runtime = ManagedRuntime.make(
      makeTriggerTestLayer(() =>
        Effect.fail(
          new OrchestrationListenerCallbackError({
            listener: "domain-event",
            detail: "dispatch failed",
          }),
        ),
      ),
    );
    const repository = await runtime.runPromise(Effect.service(AutomationScheduleRepository));
    const reactor = await runtime.runPromise(Effect.service(SchedulerReactor));
    const automationId = AutomationId.makeUnsafe("auto-trigger-failed");

    await runtime.runPromise(
      repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-trigger-failed"),
        targetThreadId: ThreadId.makeUnsafe("thread-trigger-failed"),
        title: "Manual fail",
        prompt: "Should fail",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      }),
    );

    const result = await runtime.runPromise(reactor.triggerNow(automationId));
    expect(result.status).toBe("dispatch_failed");

    const runs = await runtime.runPromise(repository.listRuns({ automationId, limit: 1 }));
    expect(runs[0]?.status).toBe("failed");
  });
});
