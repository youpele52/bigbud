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
import { Effect, Layer, Ref } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { AutomationScheduleRepositoryLive } from "../../persistence/Layers/AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  handleAutomationTerminalEvent,
  makeLoadScheduleKind,
  reconcileStartedAutomationRuns,
} from "./SchedulerReactor.reconcile.ts";

const baseLayer = Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory);
const reconcileLayer = Layer.mergeAll(
  AutomationScheduleRepositoryLive,
  ProjectionTurnRepositoryLive,
).pipe(Layer.provideMerge(baseLayer));
const reconcileTestLayer = it.layer(reconcileLayer);

const clearAutomationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM automation_runs`;
  yield* sql`DELETE FROM automation_schedules`;
  yield* sql`DELETE FROM projection_turns`;
});

reconcileTestLayer("SchedulerReactor reconciliation", (it) => {
  it.effect("redispatches runs that were started but never dispatched", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const automationId = AutomationId.makeUnsafe("auto-redispatch");
      const threadId = ThreadId.makeUnsafe("thread-redispatch");
      const messageId = MessageId.makeUnsafe("msg-redispatch");
      const runId = AutomationRunId.makeUnsafe("run-redispatch");

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-redispatch"),
        targetThreadId: threadId,
        title: "Redispatch",
        prompt: "Recover after crash",
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
        messageId,
        commandId: CommandId.makeUnsafe("cmd-redispatch"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: new Date().toISOString(),
      });

      const dispatchCount = yield* Ref.make(0);
      const orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch"> = {
        dispatch: () =>
          Ref.update(dispatchCount, (count) => count + 1).pipe(Effect.as({ sequence: 1 })),
      };

      yield* reconcileStartedAutomationRuns({
        repository,
        projectionTurnRepository,
        orchestrationEngine: orchestrationEngine as unknown as OrchestrationEngineShape,
        staleRunTimeoutMs: 60_000,
        limit: 10,
        loadScheduleKind: makeLoadScheduleKind(repository),
      });

      assert.strictEqual(yield* Ref.get(dispatchCount), 1);

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      assert.notStrictEqual(runs[0]?.dispatchedAt, null);
    }),
  );

  it.effect("marks stale dispatched runs as failed", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const automationId = AutomationId.makeUnsafe("auto-stale");
      const threadId = ThreadId.makeUnsafe("thread-stale");
      const runId = AutomationRunId.makeUnsafe("run-stale");
      const startedAt = new Date(Date.now() - 120_000).toISOString();

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-stale"),
        targetThreadId: threadId,
        title: "Stale",
        prompt: "Timeout",
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
        messageId: MessageId.makeUnsafe("msg-stale"),
        commandId: CommandId.makeUnsafe("cmd-stale"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt,
      });
      yield* repository.recordRunDispatched({
        runId,
        dispatchedAt: startedAt,
      });

      yield* reconcileStartedAutomationRuns({
        repository,
        projectionTurnRepository,
        orchestrationEngine: {
          dispatch: () => Effect.die("should not redispatch"),
        } as unknown as OrchestrationEngineShape,
        staleRunTimeoutMs: 60_000,
        limit: 10,
        loadScheduleKind: makeLoadScheduleKind(repository),
      });

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      assert.strictEqual(runs[0]?.status, "failed");
      assert.ok(runs[0]?.errorMessage?.includes("timed out"));
    }),
  );

  it.effect("completes started runs when the projection turn is already finished", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const automationId = AutomationId.makeUnsafe("auto-projection-complete");
      const threadId = ThreadId.makeUnsafe("thread-projection-complete");
      const messageId = MessageId.makeUnsafe("msg-projection-complete");
      const turnId = TurnId.makeUnsafe("turn-projection-complete");
      const runId = AutomationRunId.makeUnsafe("run-projection-complete");

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-projection-complete"),
        targetThreadId: threadId,
        title: "Projection",
        prompt: "Finish via reconcile",
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
        messageId,
        commandId: CommandId.makeUnsafe("cmd-projection-complete"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: new Date().toISOString(),
      });
      yield* repository.recordRunDispatched({
        runId,
        dispatchedAt: new Date().toISOString(),
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
        checkpointRef: CheckpointRef.makeUnsafe("refs/checkpoint/reconcile"),
        checkpointStatus: "ready",
        checkpointFiles: [],
      });

      yield* reconcileStartedAutomationRuns({
        repository,
        projectionTurnRepository,
        orchestrationEngine: {
          dispatch: () => Effect.die("should not redispatch"),
        } as unknown as OrchestrationEngineShape,
        staleRunTimeoutMs: 3_600_000,
        limit: 10,
        loadScheduleKind: makeLoadScheduleKind(repository),
      });

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      assert.strictEqual(runs[0]?.status, "finished");
    }),
  );

  it.effect("marks runs failed when the projection turn ended in error", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const automationId = AutomationId.makeUnsafe("auto-projection-error");
      const threadId = ThreadId.makeUnsafe("thread-projection-error");
      const messageId = MessageId.makeUnsafe("msg-projection-error");
      const turnId = TurnId.makeUnsafe("turn-projection-error");
      const runId = AutomationRunId.makeUnsafe("run-projection-error");

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-projection-error"),
        targetThreadId: threadId,
        title: "Projection error",
        prompt: "Fail via reconcile",
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
        messageId,
        commandId: CommandId.makeUnsafe("cmd-projection-error"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: new Date().toISOString(),
      });
      yield* repository.recordRunDispatched({
        runId,
        dispatchedAt: new Date().toISOString(),
      });
      yield* projectionTurnRepository.upsertByTurnId({
        turnId,
        threadId,
        pendingMessageId: messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "error",
        requestedAt: "2026-06-16T10:00:01.000Z",
        startedAt: "2026-06-16T10:00:01.000Z",
        completedAt: "2026-06-16T10:05:00.000Z",
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("refs/checkpoint/error"),
        checkpointStatus: "error",
        checkpointFiles: [],
      });

      yield* reconcileStartedAutomationRuns({
        repository,
        projectionTurnRepository,
        orchestrationEngine: {
          dispatch: () => Effect.die("should not redispatch"),
        } as unknown as OrchestrationEngineShape,
        staleRunTimeoutMs: 3_600_000,
        limit: 10,
        loadScheduleKind: makeLoadScheduleKind(repository),
      });

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      assert.strictEqual(runs[0]?.status, "failed");
      assert.ok(runs[0]?.errorMessage?.includes("error"));
    }),
  );

  it.effect("completes runs from assistant message-sent terminal events", () =>
    Effect.gen(function* () {
      yield* clearAutomationTables;
      const repository = yield* AutomationScheduleRepository;
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const automationId = AutomationId.makeUnsafe("auto-message-sent");
      const threadId = ThreadId.makeUnsafe("thread-message-sent");
      const messageId = MessageId.makeUnsafe("msg-message-sent");
      const turnId = TurnId.makeUnsafe("turn-message-sent");
      const eventId = EventId.makeUnsafe("event-message-sent");

      yield* repository.create({
        automationId,
        projectId: ProjectId.makeUnsafe("project-message-sent"),
        targetThreadId: threadId,
        title: "Message sent",
        prompt: "Run",
        scheduleKind: "custom",
        scheduleLabel: "Hourly",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        runAt: null,
        nextRunAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunStarted({
        runId: AutomationRunId.makeUnsafe("run-message-sent"),
        automationId,
        threadId,
        messageId,
        commandId: CommandId.makeUnsafe("cmd-message-sent"),
        triggerKind: "scheduled",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        startedAt: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.recordRunDispatched({
        runId: AutomationRunId.makeUnsafe("run-message-sent"),
        dispatchedAt: "2026-06-16T10:00:01.000Z",
      });
      yield* projectionTurnRepository.upsertByTurnId({
        turnId,
        threadId,
        pendingMessageId: messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: MessageId.makeUnsafe("assistant-message-sent"),
        state: "completed",
        requestedAt: "2026-06-16T10:00:01.000Z",
        startedAt: "2026-06-16T10:00:01.000Z",
        completedAt: "2026-06-16T10:05:00.000Z",
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("refs/checkpoint/message-sent"),
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
          correlationId: CorrelationId.makeUnsafe("cmd-message-sent"),
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId,
            turnId,
            messageId: MessageId.makeUnsafe("assistant-message-sent"),
            role: "assistant",
            text: "Done",
            streaming: false,
            createdAt: "2026-06-16T10:05:00.000Z",
            updatedAt: "2026-06-16T10:05:00.000Z",
          },
        },
      });

      const runs = yield* repository.listRuns({ automationId, limit: 1 });
      assert.strictEqual(runs[0]?.status, "finished");
      assert.strictEqual(runs[0]?.providerTerminalEventId, eventId);
    }),
  );
});
