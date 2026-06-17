import { AutomationId, ProjectId, ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { Duration, Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomationScheduleRepositoryLive } from "../../persistence/Layers/AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationListenerCallbackError } from "../Errors.ts";
import { SchedulerConfig } from "../Services/SchedulerConfig.ts";
import { SchedulerReactor } from "../Services/SchedulerReactor.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SchedulerReactorLive } from "./SchedulerReactor.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";

describe("SchedulerReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    SchedulerReactor | AutomationScheduleRepository | OrchestrationEngineService,
    unknown
  > | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("dispatches thread.turn.start for due schedules", async () => {
    const dispatchedCommands: Array<{ type: string; threadId: string; text: string }> = [];

    const testLayer = Layer.empty.pipe(
      Layer.provideMerge(SchedulerReactorLive),
      Layer.provideMerge(ProjectionTurnRepositoryLive),
      Layer.provideMerge(AutomationScheduleRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        Layer.succeed(SchedulerConfig, {
          tickInterval: Duration.millis(50),
          leaseDuration: Duration.millis(500),
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
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.turn.start") {
                dispatchedCommands.push({
                  type: command.type,
                  threadId: command.threadId,
                  text: command.message.text,
                });
              }
              return { sequence: 1 };
            }),
          streamDomainEvents: Stream.fromIterable([] as ReadonlyArray<OrchestrationEvent>),
        }),
      ),
    );

    runtime = ManagedRuntime.make(testLayer);
    if (!runtime) {
      throw new Error("Failed to initialize test runtime");
    }

    const repository = await runtime.runPromise(Effect.service(AutomationScheduleRepository));
    const reactor = await runtime.runPromise(Effect.service(SchedulerReactor));

    await runtime.runPromise(
      repository.create({
        automationId: AutomationId.makeUnsafe("auto-reactor-1"),
        projectId: ProjectId.makeUnsafe("project-reactor-1"),
        targetThreadId: ThreadId.makeUnsafe("thread-reactor-1"),
        title: "Reactor test",
        prompt: "Run from reactor",
        scheduleKind: "custom",
        scheduleLabel: "Every minute",
        cronExpression: "* * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );

    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    await new Promise((resolve) => setTimeout(resolve, 200));

    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(dispatchedCommands.length).toBeGreaterThanOrEqual(1);
    expect(dispatchedCommands[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: "thread-reactor-1",
    });
    expect(dispatchedCommands[0]!.text).toContain("Run from reactor");

    const runs = await runtime.runPromise(
      repository.listRuns({
        automationId: AutomationId.makeUnsafe("auto-reactor-1"),
        limit: 10,
      }),
    );
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]?.status).toBe("started");
    expect(runs[0]?.dispatchedAt).not.toBeNull();
  });

  it("rolls back nextRunAt when recurring dispatch fails", async () => {
    const scheduledFor = "2026-06-16T12:00:00.000Z";
    const testLayer = Layer.empty.pipe(
      Layer.provideMerge(SchedulerReactorLive),
      Layer.provideMerge(ProjectionTurnRepositoryLive),
      Layer.provideMerge(AutomationScheduleRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        Layer.succeed(SchedulerConfig, {
          tickInterval: Duration.millis(50),
          leaseDuration: Duration.millis(500),
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
          dispatch: () =>
            Effect.fail(
              new OrchestrationListenerCallbackError({
                listener: "domain-event",
                detail: "dispatch failed",
              }),
            ),
          streamDomainEvents: Stream.fromIterable([] as ReadonlyArray<OrchestrationEvent>),
        }),
      ),
    );

    runtime = ManagedRuntime.make(testLayer);
    const repository = await runtime.runPromise(Effect.service(AutomationScheduleRepository));
    const reactor = await runtime.runPromise(Effect.service(SchedulerReactor));
    const automationId = AutomationId.makeUnsafe("auto-dispatch-rollback");

    await runtime.runPromise(
      repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-dispatch-rollback"),
        targetThreadId: ThreadId.makeUnsafe("thread-dispatch-rollback"),
        title: "Rollback",
        prompt: "Should retry",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: scheduledFor,
      }),
    );

    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await Effect.runPromise(Scope.close(scope, Exit.void));

    const schedule = await runtime.runPromise(repository.getById({ automationId }));
    expect(Option.isSome(schedule)).toBe(true);
    if (Option.isSome(schedule)) {
      expect(schedule.value.nextRunAt).toBe(scheduledFor);
    }

    const runs = await runtime.runPromise(repository.listRuns({ automationId, limit: 1 }));
    expect(runs[0]?.status).toBe("failed");
  });
});
