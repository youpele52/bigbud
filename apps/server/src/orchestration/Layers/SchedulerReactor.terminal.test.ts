import {
  AutomationId,
  AutomationRunId,
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { AutomationScheduleRepositoryLive } from "../../persistence/Layers/AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { completeAutomationRun } from "./SchedulerReactor.logic.ts";
import {
  handleAutomationTerminalEvent,
  makeLoadScheduleKind,
} from "./SchedulerReactor.reconcile.ts";

const baseLayer = Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory);
const repositoryLayer = Layer.mergeAll(
  AutomationScheduleRepositoryLive,
  ProjectionTurnRepositoryLive,
).pipe(Layer.provideMerge(baseLayer));

const terminalTestLayer = it.layer(repositoryLayer);

const clearAutomationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM automation_runs`;
  yield* sql`DELETE FROM automation_schedules`;
  yield* sql`DELETE FROM projection_turns`;
});

terminalTestLayer("SchedulerReactor terminal handling", (it) => {
  it.effect("marks a started run finished when a terminal turn event arrives", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const automationId = AutomationId.makeUnsafe("auto-terminal");
      const threadId = ThreadId.makeUnsafe("thread-terminal");
      const messageId = MessageId.makeUnsafe("msg-terminal");
      const turnId = TurnId.makeUnsafe("turn-terminal");
      const eventId = EventId.makeUnsafe("event-terminal");

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-terminal"),
        targetThreadId: threadId,
        title: "Terminal test",
        prompt: "Run",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.recordRunStarted({
        runId: AutomationRunId.makeUnsafe("run-terminal"),
        automationId,
        threadId,
        messageId,
        commandId: CommandId.makeUnsafe("cmd-terminal"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunDispatched({
        runId: AutomationRunId.makeUnsafe("run-terminal"),
        dispatchedAt: "2026-06-16T10:00:01.000Z",
      });

      yield* projectionTurnRepository.upsertByTurnId({
        turnId,
        threadId,
        pendingMessageId: messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "completed",
        requestedAt: "2026-06-16T10:00:01.000Z",
        startedAt: "2026-06-16T10:00:01.000Z",
        completedAt: "2026-06-16T10:05:00.000Z",
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("refs/checkpoint/1"),
        checkpointStatus: "ready",
        checkpointFiles: [],
      });

      yield* handleAutomationTerminalEvent({
        repository,
        projectionTurnRepository,
        loadScheduleKind: makeLoadScheduleKind(repository),
        event: {
          sequence: 1,
          eventId,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-06-16T10:05:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-terminal"),
          metadata: {},
          type: "thread.turn-diff-completed",
          payload: {
            threadId,
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("refs/checkpoint/1"),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: "2026-06-16T10:05:00.000Z",
          },
        },
      });

      const runs = yield* repository.listRuns({ automationId, limit: 10 });
      assert.strictEqual(runs[0]?.status, "finished");
      assert.strictEqual(runs[0]?.providerTerminalEventId, eventId);
    }),
  );

  it.effect("completes a one-time schedule only after terminal success", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const automationId = AutomationId.makeUnsafe("auto-once");
      const threadId = ThreadId.makeUnsafe("thread-once");
      const runId = AutomationRunId.makeUnsafe("run-once");

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-once"),
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
        messageId: MessageId.makeUnsafe("msg-once"),
        commandId: CommandId.makeUnsafe("cmd-once"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: "2026-06-16T10:00:00.000Z",
      });

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      yield* completeAutomationRun({
        repository,
        run: runs[0]!,
        scheduleKind: "once",
        success: true,
        providerTerminalEventId: EventId.makeUnsafe("event-once"),
      });

      const schedule = yield* repository.getById({ automationId });
      assert.ok(Option.isSome(schedule));
      assert.notStrictEqual(schedule.value.completedAt, null);
    }),
  );
});
