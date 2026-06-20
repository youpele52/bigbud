import { type AutomationRun, type OrchestrationEvent } from "@bigbud/contracts";
import { Duration, Effect, Option } from "effect";

import type { AutomationScheduleRepositoryShape } from "../../persistence/Services/AutomationScheduleRepository.ts";
import type { ProjectionTurnRepositoryShape } from "../../persistence/Services/ProjectionTurns.ts";
import type { SchedulerConfigShape } from "../Services/SchedulerConfig.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  completeAutomationRun,
  dispatchAutomationRun,
  isAutomationTerminalEvent,
} from "./SchedulerReactor.logic.ts";

export const reconcileStartedAutomationRuns = Effect.fn("reconcileStartedAutomationRuns")(
  function* (input: {
    readonly repository: AutomationScheduleRepositoryShape;
    readonly projectionTurnRepository: ProjectionTurnRepositoryShape;
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly staleRunTimeoutMs: number;
    readonly limit: number;
    readonly loadScheduleKind: (
      automationId: AutomationRun["automationId"],
    ) => Effect.Effect<"custom" | "once" | null>;
  }) {
    const nowMs = Date.now();
    const startedRuns = yield* input.repository.listStartedRuns({ limit: input.limit });

    yield* Effect.forEach(
      startedRuns,
      (run) =>
        Effect.gen(function* () {
          if (run.dispatchedAt === null) {
            const scheduleKind = yield* input.loadScheduleKind(run.automationId);
            if (scheduleKind === null) {
              return;
            }
            const schedule = yield* input.repository.getById({ automationId: run.automationId });
            if (Option.isNone(schedule) || schedule.value.deletedAt !== null) {
              return;
            }
            yield* dispatchAutomationRun({
              repository: input.repository,
              orchestrationEngine: input.orchestrationEngine,
              run,
              prompt: schedule.value.prompt,
              scheduleKind,
              automationId: run.automationId,
            });
            return;
          }

          const startedAtMs = Date.parse(run.startedAt);
          if (!Number.isNaN(startedAtMs) && nowMs - startedAtMs >= input.staleRunTimeoutMs) {
            const scheduleKind = yield* input.loadScheduleKind(run.automationId);
            if (scheduleKind === null) {
              return;
            }
            yield* completeAutomationRun({
              repository: input.repository,
              run,
              scheduleKind,
              success: false,
              errorMessage: "Automation run timed out before provider turn completed",
            });
            return;
          }

          const turn = yield* input.projectionTurnRepository.listByThreadId({
            threadId: run.threadId,
          });
          const matchingTurn = turn.find(
            (row) => row.pendingMessageId === run.messageId && row.state !== "pending",
          );
          if (!matchingTurn) {
            return;
          }

          if (matchingTurn.state === "completed") {
            const scheduleKind = yield* input.loadScheduleKind(run.automationId);
            if (scheduleKind === null) {
              return;
            }
            yield* completeAutomationRun({
              repository: input.repository,
              run,
              scheduleKind,
              success: true,
            });
            return;
          }

          if (
            matchingTurn.state === "error" ||
            matchingTurn.state === "interrupted" ||
            matchingTurn.completedAt !== null
          ) {
            const scheduleKind = yield* input.loadScheduleKind(run.automationId);
            if (scheduleKind === null) {
              return;
            }
            yield* completeAutomationRun({
              repository: input.repository,
              run,
              scheduleKind,
              success: false,
              errorMessage: `Automation turn ended with state: ${matchingTurn.state}`,
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("automation run reconciliation failed", {
              runId: run.runId,
              cause: cause.toString(),
            }),
          ),
        ),
      { concurrency: 3 },
    );
  },
);

export const handleAutomationTerminalEvent = Effect.fn("handleAutomationTerminalEvent")(
  function* (input: {
    readonly repository: AutomationScheduleRepositoryShape;
    readonly projectionTurnRepository: ProjectionTurnRepositoryShape;
    readonly event: OrchestrationEvent;
    readonly loadScheduleKind: (
      automationId: AutomationRun["automationId"],
    ) => Effect.Effect<"custom" | "once" | null>;
  }) {
    if (!isAutomationTerminalEvent(input.event)) {
      return;
    }

    if (input.event.type === "thread.message-sent") {
      if (
        input.event.payload.role !== "assistant" ||
        input.event.payload.streaming ||
        input.event.payload.turnId === null
      ) {
        return;
      }
    }

    const messageId =
      input.event.type === "thread.turn-diff-completed"
        ? yield* input.projectionTurnRepository
            .getByTurnId({
              threadId: input.event.payload.threadId,
              turnId: input.event.payload.turnId,
            })
            .pipe(
              Effect.map((turnOption) =>
                Option.isSome(turnOption) ? turnOption.value.pendingMessageId : null,
              ),
            )
        : yield* input.projectionTurnRepository
            .getByTurnId({
              threadId: input.event.payload.threadId,
              turnId: input.event.payload.turnId!,
            })
            .pipe(
              Effect.map((turnOption) =>
                Option.isSome(turnOption) ? turnOption.value.pendingMessageId : null,
              ),
            );

    if (messageId === null) {
      return;
    }

    const runOption = yield* input.repository.getStartedRunByMessageId({ messageId });
    if (Option.isNone(runOption)) {
      return;
    }

    const scheduleKind = yield* input.loadScheduleKind(runOption.value.automationId);
    if (scheduleKind === null) {
      return;
    }

    if (input.event.type === "thread.turn-diff-completed") {
      yield* completeAutomationRun({
        repository: input.repository,
        run: runOption.value,
        scheduleKind,
        success: input.event.payload.status !== "error",
        providerTerminalEventId: input.event.eventId,
        ...(input.event.payload.status === "error"
          ? { errorMessage: "Automation turn checkpoint failed" }
          : {}),
      });
      return;
    }

    yield* completeAutomationRun({
      repository: input.repository,
      run: runOption.value,
      scheduleKind,
      success: true,
      providerTerminalEventId: input.event.eventId,
    });
  },
);

export const makeLoadScheduleKind = (repository: AutomationScheduleRepositoryShape) => {
  return (automationId: AutomationRun["automationId"]) =>
    repository.getById({ automationId }).pipe(
      Effect.map((schedule) =>
        Option.isNone(schedule) || schedule.value.deletedAt !== null
          ? null
          : schedule.value.scheduleKind,
      ),
      Effect.catch(() => Effect.succeed(null)),
    );
};

export const reconcileFromConfig = Effect.fn("reconcileFromConfig")(function* (deps: {
  readonly repository: AutomationScheduleRepositoryShape;
  readonly projectionTurnRepository: ProjectionTurnRepositoryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly config: SchedulerConfigShape;
}) {
  const loadScheduleKind = makeLoadScheduleKind(deps.repository);
  yield* reconcileStartedAutomationRuns({
    repository: deps.repository,
    projectionTurnRepository: deps.projectionTurnRepository,
    orchestrationEngine: deps.orchestrationEngine,
    staleRunTimeoutMs: Duration.toMillis(deps.config.staleRunTimeout),
    limit: deps.config.reconcileBatchSize,
    loadScheduleKind,
  });
});
