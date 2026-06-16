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

const repositoryTestLayer = it.layer(repositoryLayer);

const clearAutomationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM automation_runs`;
  yield* sql`DELETE FROM automation_schedules`;
});

repositoryTestLayer("AutomationScheduleRepository", (it) => {
  it.effect("creates and retrieves a schedule", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-1");
      const threadId = ThreadId.makeUnsafe("thread-1");

      yield* repository.create({
        automationId,
        projectId: null,
        targetThreadId: threadId,
        title: "Daily summary",
        prompt: "Summarize yesterday's work",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        nextRunAt: "2026-06-16T09:00:00.000Z",
      });

      const found = yield* repository.getById({ automationId });
      assert.ok(Option.isSome(found));
      assert.strictEqual(found.value.automationId, automationId);
      assert.strictEqual(found.value.targetThreadId, threadId);
      assert.strictEqual(found.value.cronExpression, "0 9 * * *");
    }),
  );

  it.effect("lists schedules by thread excluding deleted", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const threadId = ThreadId.makeUnsafe("thread-2");

      yield* repository.create({
        automationId: AutomationId.makeUnsafe("auto-2a"),
        projectId: null,
        targetThreadId: threadId,
        title: "A",
        prompt: "Prompt A",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.create({
        automationId: AutomationId.makeUnsafe("auto-2b"),
        projectId: null,
        targetThreadId: threadId,
        title: "B",
        prompt: "Prompt B",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.delete({
        automationId: AutomationId.makeUnsafe("auto-2b"),
        deletedAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });

      const schedules = yield* repository.listByThread({ threadId });
      assert.strictEqual(schedules.length, 1);
      assert.strictEqual(schedules[0]?.title, "A");
    }),
  );

  it.effect("claims due schedules once", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-3");
      const threadId = ThreadId.makeUnsafe("thread-3");

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-3"),
        targetThreadId: threadId,
        title: "Due",
        prompt: "Run now",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        nextRunAt: "2026-06-16T12:00:00.000Z",
      });

      const firstClaim = yield* repository.claimDue({
        now: "2026-06-16T12:00:00.000Z",
        leaseUntil: "2026-06-16T12:05:00.000Z",
        limit: 10,
      });
      assert.strictEqual(firstClaim.length, 1);
      assert.strictEqual(firstClaim[0]?.automationId, automationId);

      const secondClaim = yield* repository.claimDue({
        now: "2026-06-16T12:00:00.000Z",
        leaseUntil: "2026-06-16T12:05:00.000Z",
        limit: 10,
      });
      assert.strictEqual(secondClaim.length, 0);

      yield* repository.updateNextRun({
        automationId,
        nextRunAt: "2026-06-16T13:00:00.000Z",
        updatedAt: "2026-06-16T12:00:00.000Z",
      });

      const thirdClaim = yield* repository.claimDue({
        now: "2026-06-16T13:00:00.000Z",
        leaseUntil: "2026-06-16T13:05:00.000Z",
        limit: 10,
      });
      assert.strictEqual(thirdClaim.length, 1);
    }),
  );

  it.effect("does not claim paused or deleted schedules", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;

      yield* repository.create({
        automationId: AutomationId.makeUnsafe("auto-paused"),
        projectId: null,
        targetThreadId: ThreadId.makeUnsafe("thread-paused"),
        title: "Paused",
        prompt: "Run later",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.pause({
        automationId: AutomationId.makeUnsafe("auto-paused"),
        pausedAt: "2026-06-16T09:00:00.000Z",
        updatedAt: "2026-06-16T09:00:00.000Z",
      });

      yield* repository.create({
        automationId: AutomationId.makeUnsafe("auto-deleted"),
        projectId: null,
        targetThreadId: ThreadId.makeUnsafe("thread-deleted"),
        title: "Deleted",
        prompt: "Never run",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.delete({
        automationId: AutomationId.makeUnsafe("auto-deleted"),
        deletedAt: "2026-06-16T09:00:00.000Z",
        updatedAt: "2026-06-16T09:00:00.000Z",
      });

      const claimed = yield* repository.claimDue({
        now: "2026-06-16T10:00:00.000Z",
        leaseUntil: "2026-06-16T10:05:00.000Z",
        limit: 10,
      });
      assert.strictEqual(claimed.length, 0);
    }),
  );

  it.effect("records run history", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-4");
      const threadId = ThreadId.makeUnsafe("thread-4");

      yield* repository.create({
        automationId,
        projectId: null,
        targetThreadId: threadId,
        title: "Run history",
        prompt: "Test",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.recordRunStarted({
        runId: AutomationRunId.makeUnsafe("run-1"),
        automationId,
        threadId,
        messageId: MessageId.makeUnsafe("msg-1"),
        commandId: CommandId.makeUnsafe("cmd-1"),
        startedAt: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.recordRunFinished({
        runId: AutomationRunId.makeUnsafe("run-1"),
        finishedAt: "2026-06-16T10:01:00.000Z",
      });

      const runs = yield* repository.listRuns({ automationId, limit: 10 });
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, "finished");
      assert.strictEqual(runs[0]?.finishedAt, "2026-06-16T10:01:00.000Z");
    }),
  );
});
