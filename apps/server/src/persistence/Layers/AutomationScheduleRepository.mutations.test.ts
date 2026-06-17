import {
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { AutomationScheduleRepositoryLive } from "./AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../Services/AutomationScheduleRepository.ts";

const baseLayer = Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory);
const repositoryLayer = AutomationScheduleRepositoryLive.pipe(Layer.provideMerge(baseLayer));
const mutationsTestLayer = it.layer(repositoryLayer);

const clearAutomationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM automation_runs`;
  yield* sql`DELETE FROM automation_schedules`;
});

const createActiveSchedule = (
  automationId: AutomationId,
  threadId: ThreadId,
  nextRunAt = "2026-06-16T10:00:00.000Z",
) =>
  Effect.gen(function* () {
    const repository = yield* AutomationScheduleRepository;
    yield* repository.create({
      automationId,
      projectId: ProjectId.makeUnsafe("project-mutations"),
      targetThreadId: threadId,
      title: "Mutations",
      prompt: "Test",
      scheduleKind: "custom",
      scheduleLabel: "Hourly",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      runAt: null,
      nextRunAt,
    });
  });

mutationsTestLayer("AutomationScheduleRepository mutations", (it) => {
  it.effect("claimOccurrence advances schedule and deduplicates occurrence", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-claim");
      const threadId = ThreadId.makeUnsafe("thread-claim");
      const scheduledFor = "2026-06-16T12:00:00.000Z";

      yield* createActiveSchedule(automationId, threadId, scheduledFor);

      const firstOccurrence = yield* repository.claimOccurrence({
        automationId,
        scheduledFor,
        nextRunAt: "2026-06-16T13:00:00.000Z",
        runId: AutomationRunId.makeUnsafe("run-claim-1"),
        threadId,
        messageId: MessageId.makeUnsafe("msg-claim-1"),
        commandId: CommandId.makeUnsafe("cmd-claim-1"),
        startedAt: scheduledFor,
        updatedAt: scheduledFor,
      });
      assert.ok(Option.isSome(firstOccurrence));

      const duplicateOccurrence = yield* repository.claimOccurrence({
        automationId,
        scheduledFor,
        nextRunAt: "2026-06-16T14:00:00.000Z",
        runId: AutomationRunId.makeUnsafe("run-claim-2"),
        threadId,
        messageId: MessageId.makeUnsafe("msg-claim-2"),
        commandId: CommandId.makeUnsafe("cmd-claim-2"),
        startedAt: scheduledFor,
        updatedAt: scheduledFor,
      });
      assert.ok(Option.isSome(duplicateOccurrence));
      assert.strictEqual(duplicateOccurrence.value.runId, firstOccurrence.value.runId);

      const runs = yield* repository.listRuns({ automationId, limit: 10 });
      assert.strictEqual(runs.length, 1);
    }),
  );

  it.effect("pause fails when automation is already paused", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-pause-twice");
      yield* createActiveSchedule(automationId, ThreadId.makeUnsafe("thread-pause"));

      yield* repository.pause({
        automationId,
        pausedAt: "2026-06-16T09:00:00.000Z",
        updatedAt: "2026-06-16T09:00:00.000Z",
      });

      const exit = yield* Effect.exit(
        repository.pause({
          automationId,
          pausedAt: "2026-06-16T10:00:00.000Z",
          updatedAt: "2026-06-16T10:00:00.000Z",
        }),
      );

      assert.ok(Exit.isFailure(exit));
    }),
  );

  it.effect("resume fails when automation is not paused", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-resume-active");
      yield* createActiveSchedule(automationId, ThreadId.makeUnsafe("thread-resume"));

      const exit = yield* Effect.exit(
        repository.resume({
          automationId,
          nextRunAt: "2026-06-16T11:00:00.000Z",
          updatedAt: "2026-06-16T10:00:00.000Z",
        }),
      );

      assert.ok(Exit.isFailure(exit));
    }),
  );

  it.effect("delete fails when automation is already deleted", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-delete-twice");
      yield* createActiveSchedule(automationId, ThreadId.makeUnsafe("thread-delete"));

      yield* repository.delete({
        automationId,
        deletedAt: "2026-06-16T09:00:00.000Z",
        updatedAt: "2026-06-16T09:00:00.000Z",
      });

      const exit = yield* Effect.exit(
        repository.delete({
          automationId,
          deletedAt: "2026-06-16T10:00:00.000Z",
          updatedAt: "2026-06-16T10:00:00.000Z",
        }),
      );

      assert.ok(Exit.isFailure(exit));
    }),
  );
});
