import {
  AutomationId,
  AutomationRunId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type AutomationRun,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it as vitestIt } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AutomationScheduleRepositoryLive } from "../../persistence/Layers/AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { OrchestrationListenerCallbackError } from "../Errors.ts";
import {
  buildAutomationExecutionPrompt,
  completeAutomationRun,
  computeNextRunAt,
  dispatchAutomationRun,
  isAutomationTerminalEvent,
} from "./SchedulerReactor.logic.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";

const baseLayer = Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory);
const repositoryLayer = AutomationScheduleRepositoryLive.pipe(Layer.provideMerge(baseLayer));
const logicTestLayer = it.layer(repositoryLayer);

const clearAutomationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM automation_runs`;
  yield* sql`DELETE FROM automation_schedules`;
});

function makeOrchestrationEngineMock(
  dispatch: OrchestrationEngineShape["dispatch"],
): OrchestrationEngineShape {
  return {
    getReadModel: () => Effect.succeed(createEmptyReadModel(new Date().toISOString())),
    readEvents: () => Stream.empty,
    dispatch,
    get streamDomainEvents() {
      return Stream.empty;
    },
  };
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    runId: AutomationRunId.makeUnsafe("run-logic"),
    automationId: AutomationId.makeUnsafe("auto-logic"),
    threadId: ThreadId.makeUnsafe("thread-logic"),
    messageId: MessageId.makeUnsafe("msg-logic"),
    commandId: CommandId.makeUnsafe("cmd-logic"),
    triggerKind: "scheduled",
    scheduledFor: "2026-06-16T10:00:00.000Z",
    status: "started",
    startedAt: "2026-06-16T10:00:00.000Z",
    dispatchedAt: null,
    finishedAt: null,
    providerTerminalEventId: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("SchedulerReactor.logic", () => {
  vitestIt("buildAutomationExecutionPrompt includes the schedule prompt", () => {
    const prompt = buildAutomationExecutionPrompt("Ship the release", "2026-06-16T10:00:00.000Z");
    expect(prompt).toContain("Ship the release");
    expect(prompt).toContain("2026-06-16T10:00:00.000Z");
    expect(prompt).toContain("[Automated scheduled task]");
  });

  vitestIt("isAutomationTerminalEvent recognizes terminal orchestration events", () => {
    expect(
      isAutomationTerminalEvent({
        type: "thread.turn-diff-completed",
      } as Parameters<typeof isAutomationTerminalEvent>[0]),
    ).toBe(true);
    expect(
      isAutomationTerminalEvent({
        type: "thread.message-sent",
      } as Parameters<typeof isAutomationTerminalEvent>[0]),
    ).toBe(true);
    expect(
      isAutomationTerminalEvent({
        type: "thread.turn.started",
      } as unknown as Parameters<typeof isAutomationTerminalEvent>[0]),
    ).toBe(false);
  });

  vitestIt("computeNextRunAt advances recurring schedules", async () => {
    const result = await computeNextRunAt({
      scheduleKind: "custom",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      now: "2026-06-16T10:15:00.000Z",
    }).pipe(Effect.runPromise);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextRunAt).toBe("2026-06-16T11:00:00.000Z");
    }
  });

  vitestIt("computeNextRunAt returns null next run for one-time schedules", async () => {
    const result = await computeNextRunAt({
      scheduleKind: "once",
      cronExpression: "@once",
      timezone: "UTC",
      now: "2026-06-16T10:00:00.000Z",
    }).pipe(Effect.runPromise);

    expect(result).toEqual({ ok: true, nextRunAt: null });
  });

  vitestIt("computeNextRunAt fails for invalid cron expressions", async () => {
    const result = await computeNextRunAt({
      scheduleKind: "custom",
      cronExpression: "not-a-cron",
      timezone: "UTC",
      now: "2026-06-16T10:00:00.000Z",
    }).pipe(Effect.runPromise);

    expect(result.ok).toBe(false);
  });
});

logicTestLayer("SchedulerReactor.logic dispatch", (it) => {
  it.effect("dispatchAutomationRun records dispatch and skips duplicate dispatch", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-dispatch");
      const threadId = ThreadId.makeUnsafe("thread-dispatch");
      const run = makeRun({
        automationId,
        threadId,
        runId: AutomationRunId.makeUnsafe("run-dispatch"),
        messageId: MessageId.makeUnsafe("msg-dispatch"),
        commandId: CommandId.makeUnsafe("cmd-dispatch"),
      });

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-dispatch"),
        targetThreadId: threadId,
        title: "Dispatch",
        prompt: "Do work",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunStarted({
        runId: run.runId,
        automationId,
        threadId,
        messageId: run.messageId,
        commandId: run.commandId,
        triggerKind: "scheduled",
        scheduledFor: run.scheduledFor,
        startedAt: run.startedAt,
      });

      const orchestrationEngine = makeOrchestrationEngineMock((command) => {
        if (command.type !== "thread.turn.start") {
          assert.fail("unexpected command type");
        }
        assert.ok(command.message.text.includes("Do work"));
        return Effect.succeed({ sequence: 1 });
      });

      const first = yield* dispatchAutomationRun({
        repository,
        orchestrationEngine,
        run,
        prompt: "Do work",
        scheduleKind: "custom",
        automationId,
      });
      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.skipped, false);

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      assert.notStrictEqual(runs[0]?.dispatchedAt, null);

      const second = yield* dispatchAutomationRun({
        repository,
        orchestrationEngine,
        run: runs[0]!,
        prompt: "Do work",
        scheduleKind: "custom",
        automationId,
      });
      assert.strictEqual(second.ok, true);
      assert.strictEqual(second.skipped, true);
    }),
  );

  it.effect("dispatchAutomationRun records failure and pauses one-time schedules", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-dispatch-fail");
      const threadId = ThreadId.makeUnsafe("thread-dispatch-fail");
      const run = makeRun({
        automationId,
        threadId,
        runId: AutomationRunId.makeUnsafe("run-dispatch-fail"),
        messageId: MessageId.makeUnsafe("msg-dispatch-fail"),
        commandId: CommandId.makeUnsafe("cmd-dispatch-fail"),
        triggerKind: "manual",
        scheduledFor: null,
      });

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-dispatch-fail"),
        targetThreadId: threadId,
        title: "Once",
        prompt: "Run once",
        scheduleKind: "once",
        scheduleLabel: "Once",
        cronExpression: "@once",
        timezone: "UTC",
        runAt: "2026-06-16T10:00:00.000Z",
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunStarted({
        runId: run.runId,
        automationId,
        threadId,
        messageId: run.messageId,
        commandId: run.commandId,
        triggerKind: "manual",
        scheduledFor: null,
        startedAt: run.startedAt,
      });

      const result = yield* dispatchAutomationRun({
        repository,
        orchestrationEngine: makeOrchestrationEngineMock(() =>
          Effect.fail(
            new OrchestrationListenerCallbackError({
              listener: "domain-event",
              detail: "dispatch failed",
            }),
          ),
        ),
        run,
        prompt: "Run once",
        scheduleKind: "once",
        automationId,
      });
      assert.strictEqual(result.ok, false);

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      assert.strictEqual(runs[0]?.status, "failed");
      assert.ok(runs[0]?.errorMessage?.includes("Failed to dispatch"));

      const schedule = yield* repository.getById({ automationId });
      assert.ok(Option.isSome(schedule));
      assert.notStrictEqual(schedule.value.pausedAt, null);
    }),
  );

  it.effect("completeAutomationRun marks failure and pauses one-time schedules", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-complete-fail");
      const threadId = ThreadId.makeUnsafe("thread-complete-fail");
      const runId = AutomationRunId.makeUnsafe("run-complete-fail");

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-complete-fail"),
        targetThreadId: threadId,
        title: "Once",
        prompt: "Run once",
        scheduleKind: "once",
        scheduleLabel: "Once",
        cronExpression: "@once",
        timezone: "UTC",
        runAt: "2026-06-16T10:00:00.000Z",
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunStarted({
        runId,
        automationId,
        threadId,
        messageId: MessageId.makeUnsafe("msg-complete-fail"),
        commandId: CommandId.makeUnsafe("cmd-complete-fail"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunDispatched({
        runId,
        dispatchedAt: "2026-06-16T10:00:01.000Z",
      });

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      yield* completeAutomationRun({
        repository,
        run: runs[0]!,
        scheduleKind: "once",
        success: false,
        errorMessage: "Provider turn failed",
      });

      const updatedRuns = yield* repository.listRuns({ automationId, limit: 1 });
      assert.strictEqual(updatedRuns[0]?.status, "failed");
      assert.strictEqual(updatedRuns[0]?.errorMessage, "Provider turn failed");

      const schedule = yield* repository.getById({ automationId });
      assert.ok(Option.isSome(schedule));
      assert.notStrictEqual(schedule.value.pausedAt, null);
      assert.strictEqual(schedule.value.completedAt, null);
    }),
  );

  it.effect("completeAutomationRun stores provider terminal event id on success", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-complete-success");
      const threadId = ThreadId.makeUnsafe("thread-complete-success");
      const runId = AutomationRunId.makeUnsafe("run-complete-success");
      const terminalEventId = EventId.makeUnsafe("event-complete-success");

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-complete-success"),
        targetThreadId: threadId,
        title: "Hourly",
        prompt: "Run",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunStarted({
        runId,
        automationId,
        threadId,
        messageId: MessageId.makeUnsafe("msg-complete-success"),
        commandId: CommandId.makeUnsafe("cmd-complete-success"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: "2026-06-16T10:00:00.000Z",
      });

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      yield* completeAutomationRun({
        repository,
        run: runs[0]!,
        scheduleKind: "custom",
        success: true,
        providerTerminalEventId: terminalEventId,
      });

      const updatedRuns = yield* repository.listRuns({ automationId, limit: 1 });
      assert.strictEqual(updatedRuns[0]?.status, "finished");
      assert.strictEqual(updatedRuns[0]?.providerTerminalEventId, terminalEventId);
    }),
  );
});
