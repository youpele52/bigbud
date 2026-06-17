import {
  AutomationId,
  AutomationRunId,
  BUILT_IN_CHATS_PROJECT_ID,
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
        projectId: ProjectId.makeUnsafe("project-1"),
        targetThreadId: threadId,
        title: "Daily summary",
        prompt: "Summarize yesterday's work",
        scheduleKind: "custom",
        scheduleLabel: "Every day at 9:00 AM",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T09:00:00.000Z",
      });

      const found = yield* repository.getById({ automationId });
      assert.ok(Option.isSome(found));
      assert.strictEqual(found.value.automationId, automationId);
      assert.strictEqual(found.value.targetThreadId, threadId);
      assert.strictEqual(found.value.cronExpression, "0 9 * * *");
    }),
  );

  it.effect("lists schedules by project excluding deleted", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const projectId = ProjectId.makeUnsafe("project-2");
      const threadId = ThreadId.makeUnsafe("thread-2");

      yield* repository.create({
        automationId: AutomationId.makeUnsafe("auto-2a"),
        projectId,
        targetThreadId: threadId,
        title: "A",
        prompt: "Prompt A",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.create({
        automationId: AutomationId.makeUnsafe("auto-2b"),
        projectId,
        targetThreadId: threadId,
        title: "B",
        prompt: "Prompt B",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.delete({
        automationId: AutomationId.makeUnsafe("auto-2b"),
        deletedAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });

      const schedules = yield* repository.listByProject({ projectId });
      assert.strictEqual(schedules.length, 1);
      assert.strictEqual(schedules[0]?.title, "A");
    }),
  );

  it.effect("lists all schedules excluding deleted", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const projectA = ProjectId.makeUnsafe("project-a");
      const projectB = ProjectId.makeUnsafe("project-b");
      const threadId = ThreadId.makeUnsafe("thread-all");

      yield* repository.create({
        automationId: AutomationId.makeUnsafe("auto-all-a"),
        projectId: projectA,
        targetThreadId: threadId,
        title: "A",
        prompt: "Prompt A",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.create({
        automationId: AutomationId.makeUnsafe("auto-all-b"),
        projectId: projectB,
        targetThreadId: threadId,
        title: "B",
        prompt: "Prompt B",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.delete({
        automationId: AutomationId.makeUnsafe("auto-all-b"),
        deletedAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
      });

      const schedules = yield* repository.listAll();
      assert.strictEqual(schedules.length, 1);
      assert.strictEqual(schedules[0]?.title, "A");
    }),
  );

  it.effect("lists schedules with a missing project id", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-null-project");

      yield* sql`
        INSERT INTO automation_schedules (
          automation_id,
          project_id,
          target_thread_id,
          title,
          prompt,
          schedule_kind,
          schedule_label,
          cron_expression,
          timezone,
          run_at,
          next_run_at,
          paused_at,
          completed_at,
          deleted_at,
          lease_until,
          created_at,
          updated_at
        )
        VALUES (
          ${AutomationId.makeUnsafe("auto-null-project")},
          NULL,
          ${threadId},
          'Legacy automation',
          'Prompt',
          'custom',
          'Hourly',
          '0 * * * *',
          'UTC',
          NULL,
          '2026-06-16T10:00:00.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '2026-06-16T09:00:00.000Z',
          '2026-06-16T09:00:00.000Z'
        )
      `;

      const schedules = yield* repository.listAll();
      assert.strictEqual(schedules.length, 1);
      assert.strictEqual(schedules[0]?.targetThreadId, threadId);
      assert.strictEqual(schedules[0]?.projectId, BUILT_IN_CHATS_PROJECT_ID);
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
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
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
        projectId: ProjectId.makeUnsafe("project-paused"),
        targetThreadId: ThreadId.makeUnsafe("thread-paused"),
        title: "Paused",
        prompt: "Run later",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.pause({
        automationId: AutomationId.makeUnsafe("auto-paused"),
        pausedAt: "2026-06-16T09:00:00.000Z",
        updatedAt: "2026-06-16T09:00:00.000Z",
      });

      yield* repository.create({
        automationId: AutomationId.makeUnsafe("auto-deleted"),
        projectId: ProjectId.makeUnsafe("project-deleted"),
        targetThreadId: ThreadId.makeUnsafe("thread-deleted"),
        title: "Deleted",
        prompt: "Never run",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
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
        projectId: ProjectId.makeUnsafe("project-4"),
        targetThreadId: threadId,
        title: "Run history",
        prompt: "Test",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
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
