import { AutomationId, ProjectId, ThreadId, WS_METHODS } from "@bigbud/contracts";
import { Effect, Exit, Layer, Option, Cause } from "effect";
import { describe, expect, it } from "vitest";

import { AutomationScheduleRepositoryLive } from "../persistence/Layers/AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../persistence/Services/AutomationScheduleRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcAutomationHandlers } from "./wsRpcHandlers.automation.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const automationId = AutomationId.makeUnsafe("auto-rpc-test");
const threadId = ThreadId.makeUnsafe("thread-rpc-test");

function makeHandlers(
  context: Pick<WsRpcContext, "automationScheduleRepository" | "schedulerReactor">,
) {
  return makeWsRpcAutomationHandlers({
    ...({} as WsRpcContext),
    automationScheduleRepository: context.automationScheduleRepository,
    schedulerReactor: context.schedulerReactor,
    projectionThreadRepository: {
      getById: () => Effect.succeed(Option.none()),
    } as unknown as WsRpcContext["projectionThreadRepository"],
  });
}

describe("wsRpcHandlers.automation", () => {
  it("returns not found when pausing a missing automation", async () => {
    const testLayer = AutomationScheduleRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const exit = await Effect.gen(function* () {
      const repository = yield* AutomationScheduleRepository;
      const handlers = makeHandlers({
        automationScheduleRepository: repository,
        schedulerReactor: {
          start: () => Effect.void,
          triggerNow: () => Effect.succeed({ status: "not_found" as const }),
        },
      });
      return yield* Effect.exit(
        handlers[WS_METHODS.serverPauseAutomation]({
          automationId: AutomationId.makeUnsafe("missing"),
        }),
      );
    }).pipe(Effect.provide(testLayer), Effect.runPromise);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value._tag).toBe("ServerAutomationError");
        expect(error.value.message).toBe("Automation not found");
      }
    }
  });

  it("returns failure when trigger dispatch fails", async () => {
    const testLayer = AutomationScheduleRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const exit = await Effect.gen(function* () {
      const repository = yield* AutomationScheduleRepository;
      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-rpc"),
        targetThreadId: threadId,
        title: "RPC test",
        prompt: "Run",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      const handlers = makeHandlers({
        automationScheduleRepository: repository,
        schedulerReactor: {
          start: () => Effect.void,
          triggerNow: () => Effect.succeed({ status: "dispatch_failed" as const }),
        },
      });

      return yield* Effect.exit(handlers[WS_METHODS.serverTriggerAutomation]({ automationId }));
    }).pipe(Effect.provide(testLayer), Effect.runPromise);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value._tag).toBe("ServerAutomationError");
        expect(error.value.message).toBe("Failed to trigger automation");
      }
    }
  });

  it("returns dispatched when trigger succeeds", async () => {
    const testLayer = AutomationScheduleRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const result = await Effect.gen(function* () {
      const repository = yield* AutomationScheduleRepository;
      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-rpc-2"),
        targetThreadId: threadId,
        title: "RPC test",
        prompt: "Run",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      const handlers = makeHandlers({
        automationScheduleRepository: repository,
        schedulerReactor: {
          start: () => Effect.void,
          triggerNow: () =>
            Effect.succeed({
              status: "dispatched" as const,
              triggeredAt: "2026-06-16T10:00:00.000Z",
            }),
        },
      });

      return yield* handlers[WS_METHODS.serverTriggerAutomation]({ automationId });
    }).pipe(Effect.provide(testLayer), Effect.runPromise);

    expect(result.status).toBe("dispatched");
  });

  it("returns not found when resuming an active automation", async () => {
    const testLayer = AutomationScheduleRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const exit = await Effect.gen(function* () {
      const repository = yield* AutomationScheduleRepository;
      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-rpc-resume"),
        targetThreadId: threadId,
        title: "Active",
        prompt: "Run",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      const handlers = makeHandlers({
        automationScheduleRepository: repository,
        schedulerReactor: {
          start: () => Effect.void,
          triggerNow: () => Effect.succeed({ status: "not_found" as const }),
        },
      });

      return yield* Effect.exit(handlers[WS_METHODS.serverResumeAutomation]({ automationId }));
    }).pipe(Effect.provide(testLayer), Effect.runPromise);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value.message).toBe("Automation not found");
      }
    }
  });

  it("resumes a paused automation", async () => {
    const testLayer = AutomationScheduleRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const schedule = await Effect.gen(function* () {
      const repository = yield* AutomationScheduleRepository;
      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-rpc-resume-success"),
        targetThreadId: threadId,
        title: "Paused",
        prompt: "Run",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.pause({
        automationId,
        pausedAt: "2026-06-16T09:00:00.000Z",
        updatedAt: "2026-06-16T09:00:00.000Z",
      });

      const handlers = makeHandlers({
        automationScheduleRepository: repository,
        schedulerReactor: {
          start: () => Effect.void,
          triggerNow: () => Effect.succeed({ status: "not_found" as const }),
        },
      });

      yield* handlers[WS_METHODS.serverResumeAutomation]({ automationId });
      return yield* repository.getById({ automationId });
    }).pipe(Effect.provide(testLayer), Effect.runPromise);

    expect(Option.isSome(schedule)).toBe(true);
    if (Option.isSome(schedule)) {
      expect(schedule.value.pausedAt).toBeNull();
    }
  });

  it("returns not found when deleting a missing automation", async () => {
    const testLayer = AutomationScheduleRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const exit = await Effect.gen(function* () {
      const repository = yield* AutomationScheduleRepository;
      const handlers = makeHandlers({
        automationScheduleRepository: repository,
        schedulerReactor: {
          start: () => Effect.void,
          triggerNow: () => Effect.succeed({ status: "not_found" as const }),
        },
      });

      return yield* Effect.exit(
        handlers[WS_METHODS.serverDeleteAutomation]({
          automationId: AutomationId.makeUnsafe("missing-delete"),
        }),
      );
    }).pipe(Effect.provide(testLayer), Effect.runPromise);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("returns failure when triggering a completed automation", async () => {
    const testLayer = AutomationScheduleRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const exit = await Effect.gen(function* () {
      const repository = yield* AutomationScheduleRepository;
      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-rpc-trigger-completed"),
        targetThreadId: threadId,
        title: "Completed trigger",
        prompt: "Run",
        scheduleKind: "once",
        scheduleLabel: "Once",
        cronExpression: "@once",
        timezone: "UTC",
        runAt: "2026-06-16T10:00:00.000Z",
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.complete({
        automationId,
        completedAt: "2026-06-16T11:00:00.000Z",
        updatedAt: "2026-06-16T11:00:00.000Z",
      });

      const handlers = makeHandlers({
        automationScheduleRepository: repository,
        schedulerReactor: {
          start: () => Effect.void,
          triggerNow: () => Effect.succeed({ status: "paused_or_completed" as const }),
        },
      });

      return yield* Effect.exit(handlers[WS_METHODS.serverTriggerAutomation]({ automationId }));
    }).pipe(Effect.provide(testLayer), Effect.runPromise);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value.message).toBe("Automation has already completed");
      }
    }
  });
});
