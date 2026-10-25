import { expect, it, vi } from "vitest";
import { Effect, Layer, Stream, Schema } from "effect";
import {
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type AutomationRun,
  OrchestrationThread,
} from "@bigbud/contracts";
import { AutomationScheduleRepositoryLive } from "../../persistence/Layers/AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";
import { dispatchAutomationRun } from "./SchedulerReactor.logic.ts";

for (const { admitted, mode } of [false, true].flatMap((admitted) =>
  ["approval-required", "auto-accept-edits", "full-access"].map((mode) => ({ admitted, mode })),
)) {
  it(`V2 ${mode} schedule ${admitted ? "reconciles existing durable application admission without redispatch" : "dispatches only explicit Full access without escalation or fallback"}`, async () => {
    const layer = AutomationScheduleRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* AutomationScheduleRepository;
          const automationId = AutomationId.makeUnsafe(`v2-schedule-${admitted}`);
          const threadId = ThreadId.makeUnsafe(`v2-schedule-${admitted}`);
          const run: AutomationRun = {
            runId: AutomationRunId.makeUnsafe(`v2-run-${admitted}`),
            automationId,
            threadId,
            messageId: MessageId.makeUnsafe(`v2-message-${admitted}`),
            commandId: CommandId.makeUnsafe(`v2-command-${admitted}`),
            triggerKind: "scheduled",
            scheduledFor: "2026-09-30T00:00:00.000Z",
            startedAt: "2026-09-30T00:00:00.000Z",
            status: "started",
            dispatchedAt: null,
            finishedAt: null,
            providerTerminalEventId: null,
            errorMessage: null,
          };
          yield* repository.create({
            automationId,
            projectId: ProjectId.makeUnsafe("v2-project"),
            targetThreadId: threadId,
            title: "V2 task",
            prompt: "Synthetic task",
            scheduleKind: "once",
            scheduleLabel: "Once",
            cronExpression: "@once",
            timezone: "UTC",
            runAt: run.startedAt,
            nextRunAt: run.startedAt,
          });
          yield* repository.recordRunStarted({ ...run });
          const thread = Schema.decodeUnknownSync(OrchestrationThread)({
            id: threadId,
            projectId: "v2-project",
            title: "V2 task",
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt: run.startedAt,
            updatedAt: run.startedAt,
            deletedAt: null,
            session: null,
            activities: [],
            checkpoints: [],
            modelSelection: {
              provider: "opencodeV2",
              subProviderID: "synthetic",
              model: "synthetic",
            },
            runtimeMode: mode,
            interactionMode: "default",
            messages: admitted
              ? [
                  {
                    id: run.messageId,
                    role: "user",
                    text: "Synthetic task",
                    turnId: null,
                    streaming: false,
                    createdAt: run.startedAt,
                    updatedAt: run.startedAt,
                  },
                ]
              : [],
          });
          const model = { ...createEmptyReadModel(run.startedAt), threads: [thread] };
          const dispatch = vi.fn(
            (
              _command: Parameters<
                Parameters<typeof dispatchAutomationRun>[0]["orchestrationEngine"]["dispatch"]
              >[0],
            ) => Effect.succeed({ sequence: 1 }),
          );
          const engine = {
            getReadModel: () => Effect.succeed(model),
            dispatch,
            readEvents: () => Stream.empty,
            readReplay: () => Effect.die("unused replay"),
            streamDomainEvents: Stream.empty,
          };
          const result = yield* dispatchAutomationRun({
            repository,
            orchestrationEngine: engine,
            run,
            prompt: "Synthetic task",
            scheduleKind: "once",
            automationId,
          });
          expect(dispatch).toHaveBeenCalledTimes(!admitted && mode === "full-access" ? 1 : 0);
          const rows = yield* repository.listRuns({ automationId, limit: 1 });
          if (admitted) {
            expect(result).toEqual({ ok: true, skipped: true });
            expect(rows[0]?.dispatchedAt).not.toBeNull();
            yield* dispatchAutomationRun({
              repository,
              orchestrationEngine: engine,
              run: rows[0]!,
              prompt: "Synthetic task",
              scheduleKind: "once",
              automationId,
            });
            expect(dispatch).not.toHaveBeenCalled();
          } else if (mode === "full-access") {
            expect(result).toEqual({ ok: true, skipped: false });
            expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
              type: "thread.turn.start",
              runtimeMode: "full-access",
              modelSelection: thread.modelSelection,
              message: { messageId: run.messageId },
            });
            expect(rows[0]?.dispatchedAt).not.toBeNull();
            yield* dispatchAutomationRun({
              repository,
              orchestrationEngine: engine,
              run: rows[0]!,
              prompt: "Synthetic task",
              scheduleKind: "once",
              automationId,
            });
            expect(dispatch).toHaveBeenCalledTimes(1);
          } else {
            expect(result.ok).toBe(false);
            expect(rows[0]).toMatchObject({
              status: "failed",
              errorMessage: expect.stringContaining("require supervision"),
            });
            const schedule = yield* repository.getById({ automationId });
            expect(schedule._tag === "Some" && schedule.value.pausedAt !== null).toBe(true);
          }
        }).pipe(Effect.provide(layer)),
      ),
    );
  });
}
