import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import {
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ProjectId,
  type AutomationRun,
} from "@bigbud/contracts";
import { AutomationScheduleRepository } from "../../persistence/Services/AutomationScheduleRepository.ts";
import { AutomationScheduleRepositoryLive } from "../../persistence/Layers/AutomationScheduleRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { withV2RuntimeFixture } from "../../provider/Layers/OpencodeV2/Runtime.fixture.ts";
import { makeIsolatedOpencodeV2Adapter } from "../../provider/Layers/OpencodeV2/Adapter.execution.ts";
import { v2ResumeCursor } from "../../provider/Layers/OpencodeV2/Runtime.sessions.ts";
import { sendTurnForThread } from "./ProviderCommandReactorSessionOps.ts";
import {
  makeSettingsHarness,
  threadId,
  createdAt,
} from "./ProviderCommandReactorSessionOps.settings.test.helpers.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";
import { dispatchAutomationRun } from "./SchedulerReactor.logic.ts";

it("scheduled Full access uses the real adapter once, retains waiting work through disable/restart and interrupts without escalation or resend", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    http.autoComplete = false;
    let enabled = true;
    Object.assign(runtime.options, {
      authorizeExecution: async () => {
        if (!enabled) throw new Error("preview disabled");
      },
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* AutomationScheduleRepository;
          const { adapter, runtime: owned } = yield* makeIsolatedOpencodeV2Adapter(runtime.options);
          const h = makeSettingsHarness("opencodeV2");
          const modelSelection = {
            provider: "opencodeV2" as const,
            model: "synthetic-model",
            subProviderID: "synthetic-provider",
          };
          h.updateThread({
            modelSelection,
            runtimeMode: "full-access",
            worktreePath: directory,
            workspaceExecutionTargetId: "local",
            providerRuntimeExecutionTargetId: "local",
            executionTargetId: "local",
          });
          Object.assign(h.services.serverConfig, { stateDir: directory });
          h.getCapabilities.mockImplementation(() => Effect.succeed(adapter.capabilities));
          h.startSession.mockImplementation((_thread, input) => adapter.startSession(input));
          h.sendTurn.mockImplementation((input) => adapter.sendTurn(input));
          Object.assign(h.services.providerService, { listSessions: adapter.listSessions });
          const automationId = AutomationId.makeUnsafe("v2-scheduled-integration");
          const run: AutomationRun = {
            runId: AutomationRunId.makeUnsafe("scheduled-owned-run"),
            automationId,
            threadId,
            messageId: MessageId.makeUnsafe("scheduled-owned-message"),
            commandId: CommandId.makeUnsafe("scheduled-owned-command"),
            triggerKind: "scheduled",
            scheduledFor: createdAt,
            startedAt: createdAt,
            status: "started",
            dispatchedAt: null,
            finishedAt: null,
            providerTerminalEventId: null,
            errorMessage: null,
          };
          yield* repository.create({
            automationId,
            projectId: ProjectId.makeUnsafe("settings-project"),
            targetThreadId: threadId,
            title: "Scheduled integration",
            prompt: "Synthetic scheduled execution",
            scheduleKind: "once",
            scheduleLabel: "Once",
            cronExpression: "@once",
            timezone: "UTC",
            runAt: createdAt,
            nextRunAt: createdAt,
          });
          yield* repository.recordRunStarted(run);
          const dispatch = vi.fn(
            (
              command: Parameters<
                Parameters<typeof dispatchAutomationRun>[0]["orchestrationEngine"]["dispatch"]
              >[0],
            ) => {
              if (command.type !== "thread.turn.start")
                return Effect.die("Unexpected scheduler command");
              return sendTurnForThread(h.services)({
                threadId,
                createdAt: command.createdAt,
                modelSelection,
                messageText: command.message.text,
                providerInputText: command.message.text,
                requestMessageId: command.message.messageId,
              }).pipe(Effect.orDie, Effect.as({ sequence: 1 }));
            },
          );
          const engine = {
            getReadModel: () =>
              Effect.succeed({ ...createEmptyReadModel(createdAt), threads: [h.thread] }),
            dispatch,
            readEvents: () => Stream.empty,
            readReplay: () => Effect.die("unused replay"),
            streamDomainEvents: Stream.empty,
          };
          const schedule = {
            repository,
            orchestrationEngine: engine,
            run,
            prompt: "Synthetic scheduled execution",
            scheduleKind: "once" as const,
            automationId,
          };
          expect(yield* dispatchAutomationRun(schedule)).toEqual({ ok: true, skipped: false });
          const owner = owned.get(threadId),
            nativeId = owner.native.id;
          expect(owner.row?.state).toBe("accepted");
          expect(owner.terminalDelivered).toBe(false); // The owned native execution remains waiting.
          expect(http.calls.find((call) => call.pathname.endsWith("/prompt"))?.body.text).toContain(
            "[Automated scheduled task]",
          );
          const persisted = (yield* repository.listRuns({ automationId, limit: 1 }))[0]!;
          expect(persisted.dispatchedAt).not.toBeNull();
          const observer = yield* Effect.promise(() =>
            runtime.options.manager.acquire(runtime.options.config),
          );
          try {
            enabled = false;
            expect(yield* dispatchAutomationRun({ ...schedule, run: persisted })).toEqual({
              ok: true,
              skipped: true,
            });
            const rejected = yield* Effect.exit(
              adapter.sendTurn({
                threadId,
                modelSelection,
                requestMessageId: MessageId.makeUnsafe("new-disabled"),
                input: "must not run",
              }),
            );
            expect(rejected._tag).toBe("Failure");
            const cursor = v2ResumeCursor(owner);
            yield* adapter.stopSession(threadId);
            enabled = true;
            yield* adapter.startSession({
              threadId,
              modelSelection,
              runtimeMode: "full-access",
              cwd: directory,
              resumeCursor: cursor,
            });
            expect(owned.get(threadId).native.id).toBe(nativeId);
            expect(owned.get(threadId).row?.state).toBe("accepted");
            expect(yield* dispatchAutomationRun({ ...schedule, run: persisted })).toEqual({
              ok: true,
              skipped: true,
            });
            yield* adapter.interruptTurn(threadId);
            expect(
              http.calls.find((call) => call.pathname.endsWith("/interrupt"))?.search,
            ).toContain("resume=false");
            expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
            expect(
              http.calls.some(
                (call) => call.method === "DELETE" && call.pathname.endsWith(nativeId),
              ),
            ).toBe(false);
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(h.startSessionFresh).not.toHaveBeenCalled();
          } finally {
            yield* Effect.promise(() => observer.release());
          }
        }).pipe(
          Effect.provide(
            AutomationScheduleRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
          ),
        ),
      ),
    );
  });
});
