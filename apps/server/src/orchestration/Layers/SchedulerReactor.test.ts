import { AutomationId, ProjectId, ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { Duration, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomationScheduleRepositoryLive } from "../../persistence/Layers/AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SchedulerConfig } from "../Services/SchedulerConfig.ts";
import { SchedulerReactor } from "../Services/SchedulerReactor.ts";
import { SchedulerReactorLive } from "./SchedulerReactor.ts";

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
      Layer.provideMerge(AutomationScheduleRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        Layer.succeed(SchedulerConfig, {
          tickInterval: Duration.millis(50),
          leaseDuration: Duration.millis(500),
          claimBatchSize: 10,
          maxConcurrency: 2,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.die("not implemented in test"),
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
  });
});
