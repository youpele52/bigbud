import { Effect, Option, Schema } from "effect";
import {
  AutomationId,
  ServerAutomationError,
  ServerCreateAutomationInput,
  ServerDeleteAutomationInput,
  ServerListAutomationRunsInput,
  ServerListAutomationsInput,
  ServerPauseAutomationInput,
  ServerResumeAutomationInput,
  ServerTriggerAutomationInput,
  ServerUpdateAutomationInput,
  WS_METHODS,
} from "@bigbud/contracts";

import { getNextCronTime } from "../orchestration/Scheduler/cron.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { WsRpcContext } from "./wsRpcContext";

const DEFAULT_AUTOMATION_TIMEZONE = "UTC";

function toAutomationError(cause: unknown, message: string) {
  return Schema.is(ServerAutomationError)(cause)
    ? cause
    : new ServerAutomationError({
        message,
        cause,
      });
}

function resolveNextRunAt(input: {
  readonly cronExpression: string;
  readonly timezone: string;
  readonly now: Date;
}) {
  return Effect.try({
    try: () => getNextCronTime(input.cronExpression, input.now, input.timezone).toISOString(),
    catch: (cause) =>
      new ServerAutomationError({
        message: cause instanceof Error ? cause.message : "Invalid automation schedule",
        cause,
      }),
  });
}

export function makeWsRpcAutomationHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverListAutomations]: (input: typeof ServerListAutomationsInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverListAutomations,
        context.automationScheduleRepository.listByThread(input).pipe(
          Effect.map((automations) => ({ automations })),
          Effect.mapError((cause) =>
            toAutomationError(cause, "Failed to list automations for this thread"),
          ),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverCreateAutomation]: (input: typeof ServerCreateAutomationInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverCreateAutomation,
        Effect.gen(function* () {
          const snapshot = yield* context.projectionSnapshotQuery.getSnapshot();
          const thread = snapshot.threads.find((candidate) => candidate.id === input.threadId);
          if (!thread) {
            return yield* new ServerAutomationError({
              message: "Automation thread not found",
            });
          }

          const timezone = input.timezone ?? DEFAULT_AUTOMATION_TIMEZONE;
          const nextRunAt = yield* resolveNextRunAt({
            cronExpression: input.cronExpression,
            timezone,
            now: new Date(),
          });

          const automation = yield* context.automationScheduleRepository.create({
            automationId: AutomationId.makeUnsafe(crypto.randomUUID()),
            projectId: thread.projectId,
            targetThreadId: input.threadId,
            title: input.title,
            prompt: input.prompt,
            cronExpression: input.cronExpression,
            timezone,
            nextRunAt,
          });

          return { automation };
        }).pipe(
          Effect.mapError((cause) => toAutomationError(cause, "Failed to create automation")),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverUpdateAutomation]: (input: typeof ServerUpdateAutomationInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverUpdateAutomation,
        Effect.gen(function* () {
          const current = yield* context.automationScheduleRepository.getById({
            automationId: input.automationId,
          });
          if (Option.isNone(current) || current.value.deletedAt !== null) {
            return yield* new ServerAutomationError({
              message: "Automation not found",
            });
          }

          const timezone = input.timezone ?? current.value.timezone;
          const cronExpression = input.cronExpression ?? current.value.cronExpression;
          const shouldRecalculate =
            input.cronExpression !== undefined || input.timezone !== undefined;
          const nextRunAt =
            shouldRecalculate && current.value.pausedAt === null
              ? yield* resolveNextRunAt({ cronExpression, timezone, now: new Date() })
              : undefined;

          const automation = yield* context.automationScheduleRepository.update({
            automationId: input.automationId,
            title: input.title,
            prompt: input.prompt,
            cronExpression: input.cronExpression,
            timezone: input.timezone,
            nextRunAt,
            updatedAt: new Date().toISOString(),
          });

          return { automation };
        }).pipe(
          Effect.mapError((cause) => toAutomationError(cause, "Failed to update automation")),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverPauseAutomation]: (input: typeof ServerPauseAutomationInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverPauseAutomation,
        context.automationScheduleRepository
          .pause({
            automationId: input.automationId,
            pausedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .pipe(Effect.mapError((cause) => toAutomationError(cause, "Failed to pause automation"))),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverResumeAutomation]: (input: typeof ServerResumeAutomationInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverResumeAutomation,
        Effect.gen(function* () {
          const current = yield* context.automationScheduleRepository.getById({
            automationId: input.automationId,
          });
          if (Option.isNone(current) || current.value.deletedAt !== null) {
            return yield* new ServerAutomationError({
              message: "Automation not found",
            });
          }

          const nextRunAt = yield* resolveNextRunAt({
            cronExpression: current.value.cronExpression,
            timezone: current.value.timezone,
            now: new Date(),
          });

          yield* context.automationScheduleRepository.resume({
            automationId: input.automationId,
            nextRunAt,
            updatedAt: new Date().toISOString(),
          });
        }).pipe(
          Effect.mapError((cause) => toAutomationError(cause, "Failed to resume automation")),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverDeleteAutomation]: (input: typeof ServerDeleteAutomationInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverDeleteAutomation,
        context.automationScheduleRepository
          .delete({
            automationId: input.automationId,
            deletedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .pipe(
            Effect.mapError((cause) => toAutomationError(cause, "Failed to delete automation")),
          ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverTriggerAutomation]: (input: typeof ServerTriggerAutomationInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverTriggerAutomation,
        Effect.gen(function* () {
          const current = yield* context.automationScheduleRepository.getById({
            automationId: input.automationId,
          });
          if (Option.isNone(current) || current.value.deletedAt !== null) {
            return yield* new ServerAutomationError({
              message: "Automation not found",
            });
          }

          yield* context.schedulerReactor.triggerNow(input.automationId);
          return { triggeredAt: new Date().toISOString() };
        }).pipe(
          Effect.mapError((cause) => toAutomationError(cause, "Failed to trigger automation")),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverListAutomationRuns]: (input: typeof ServerListAutomationRunsInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverListAutomationRuns,
        context.automationScheduleRepository
          .listRuns({ automationId: input.automationId, limit: input.limit ?? 10 })
          .pipe(
            Effect.map((runs) => ({ runs })),
            Effect.mapError((cause) =>
              toAutomationError(cause, "Failed to load automation run history"),
            ),
          ),
        { "rpc.aggregate": "server" },
      ),
  };
}
