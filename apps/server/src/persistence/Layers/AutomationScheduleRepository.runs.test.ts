import {
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { AutomationScheduleRepositoryLive } from "./AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../Services/AutomationScheduleRepository.ts";

const baseLayer = Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory);
const repositoryLayer = AutomationScheduleRepositoryLive.pipe(Layer.provideMerge(baseLayer));
const runsTestLayer = it.layer(repositoryLayer);

const clearAutomationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM automation_runs`;
  yield* sql`DELETE FROM automation_schedules`;
});

const createSchedule = (automationId: AutomationId, threadId: ThreadId) =>
  Effect.gen(function* () {
    const repository = yield* AutomationScheduleRepository;
    yield* repository.create({
      automationId,
      projectId: ProjectId.makeUnsafe("project-runs"),
      targetThreadId: threadId,
      title: "Runs",
      prompt: "Test",
      scheduleKind: "custom",
      scheduleLabel: "Hourly",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      runAt: null,
      nextRunAt: "2026-06-16T10:00:00.000Z",
    });
  });

runsTestLayer("AutomationScheduleRepository runs", (it) => {
  it.effect("listStartedRuns returns only in-flight runs", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-started-runs");
      const threadId = ThreadId.makeUnsafe("thread-started-runs");

      yield* createSchedule(automationId, threadId);

      yield* repository.recordRunStarted({
        runId: AutomationRunId.makeUnsafe("run-started"),
        automationId,
        threadId,
        messageId: MessageId.makeUnsafe("msg-started"),
        commandId: CommandId.makeUnsafe("cmd-started"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunStarted({
        runId: AutomationRunId.makeUnsafe("run-finished"),
        automationId,
        threadId,
        messageId: MessageId.makeUnsafe("msg-finished"),
        commandId: CommandId.makeUnsafe("cmd-finished"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T11:00:00.000Z",
        startedAt: "2026-06-16T11:00:00.000Z",
      });
      yield* repository.recordRunFinished({
        runId: AutomationRunId.makeUnsafe("run-finished"),
        finishedAt: "2026-06-16T11:05:00.000Z",
      });
      yield* repository.recordRunStarted({
        runId: AutomationRunId.makeUnsafe("run-failed"),
        automationId,
        threadId,
        messageId: MessageId.makeUnsafe("msg-failed"),
        commandId: CommandId.makeUnsafe("cmd-failed"),
        triggerKind: "manual",
        scheduledFor: null,
        startedAt: "2026-06-16T12:00:00.000Z",
      });
      yield* repository.recordRunFailed({
        runId: AutomationRunId.makeUnsafe("run-failed"),
        finishedAt: "2026-06-16T12:01:00.000Z",
        errorMessage: "Dispatch failed",
      });

      const startedRuns = yield* repository.listStartedRuns({ limit: 10 });
      assert.strictEqual(startedRuns.length, 1);
      assert.strictEqual(startedRuns[0]?.runId, AutomationRunId.makeUnsafe("run-started"));
    }),
  );

  it.effect("getStartedRunByMessageId finds the active run for a message", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-by-message");
      const threadId = ThreadId.makeUnsafe("thread-by-message");
      const messageId = MessageId.makeUnsafe("msg-by-message");

      yield* createSchedule(automationId, threadId);
      yield* repository.recordRunStarted({
        runId: AutomationRunId.makeUnsafe("run-by-message"),
        automationId,
        threadId,
        messageId,
        commandId: CommandId.makeUnsafe("cmd-by-message"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: "2026-06-16T10:00:00.000Z",
      });

      const found = yield* repository.getStartedRunByMessageId({ messageId });
      assert.ok(Option.isSome(found));
      assert.strictEqual(found.value.messageId, messageId);

      yield* repository.recordRunFinished({
        runId: AutomationRunId.makeUnsafe("run-by-message"),
        finishedAt: "2026-06-16T10:05:00.000Z",
      });

      const afterFinish = yield* repository.getStartedRunByMessageId({ messageId });
      assert.ok(Option.isNone(afterFinish));
    }),
  );

  it.effect("recordRunFailed stores the error message and terminal status", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-failed-run");
      const threadId = ThreadId.makeUnsafe("thread-failed-run");
      const runId = AutomationRunId.makeUnsafe("run-failed-run");

      yield* createSchedule(automationId, threadId);
      yield* repository.recordRunStarted({
        runId,
        automationId,
        threadId,
        messageId: MessageId.makeUnsafe("msg-failed-run"),
        commandId: CommandId.makeUnsafe("cmd-failed-run"),
        triggerKind: "manual",
        scheduledFor: null,
        startedAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunFailed({
        runId,
        finishedAt: "2026-06-16T10:01:00.000Z",
        errorMessage: "Provider rejected the turn",
      });

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      assert.strictEqual(runs[0]?.status, "failed");
      assert.strictEqual(runs[0]?.errorMessage, "Provider rejected the turn");
      assert.strictEqual(runs[0]?.finishedAt, "2026-06-16T10:01:00.000Z");
    }),
  );
});
