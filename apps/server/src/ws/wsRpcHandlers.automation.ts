import { Effect, Option } from "effect";
import {
  CommandId,
  ServerAutomationError,
  ServerDeleteAutomationInput,
  ServerGetAutomationInput,
  ServerListAutomationRunsInput,
  ServerListAutomationsInput,
  ServerPauseAutomationInput,
  ServerResumeAutomationInput,
  ServerTriggerAutomationInput,
  ServerUpdateAutomationInput,
  WS_METHODS,
} from "@bigbud/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcAutomationCreateHandlers } from "./wsRpcHandlers.automation.create.ts";
import { resolveNextRunAt, toAutomationError } from "./wsRpcHandlers.automation.shared.ts";

export function makeWsRpcAutomationHandlers(context: WsRpcContext) {
  return {
    ...makeWsRpcAutomationCreateHandlers(context),
    [WS_METHODS.serverGetAutomation]: (input: typeof ServerGetAutomationInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverGetAutomation,
        context.automationScheduleRepository.getById(input).pipe(
          Effect.flatMap((automation) =>
            Option.isNone(automation) || automation.value.deletedAt !== null
              ? Effect.fail(
                  new ServerAutomationError({
                    message: "Automation not found",
                  }),
                )
              : Effect.succeed({ automation: automation.value }),
          ),
          Effect.mapError((cause) => toAutomationError(cause, "Failed to load automation")),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverListAutomations]: (input: typeof ServerListAutomationsInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverListAutomations,
        context.automationScheduleRepository.listByProject(input).pipe(
          Effect.map((automations) => ({ automations })),
          Effect.mapError((cause) =>
            toAutomationError(cause, "Failed to list automations for this project"),
          ),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverListAllAutomations]: () =>
      observeRpcEffect(
        WS_METHODS.serverListAllAutomations,
        context.automationScheduleRepository.listAll().pipe(
          Effect.map((automations) => ({ automations })),
          Effect.mapError((cause) => toAutomationError(cause, "Failed to list automations")),
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
          const scheduleKind = input.scheduleKind ?? current.value.scheduleKind;
          const shouldRecalculate =
            input.cronExpression !== undefined ||
            input.timezone !== undefined ||
            input.scheduleKind !== undefined ||
            input.runAt !== undefined;
          const nextRunAt =
            shouldRecalculate && current.value.pausedAt === null
              ? yield* resolveNextRunAt({
                  cronExpression,
                  runAt: input.runAt ?? current.value.runAt,
                  scheduleKind,
                  timezone,
                  now: new Date(),
                })
              : undefined;

          const automation = yield* context.automationScheduleRepository.update({
            automationId: input.automationId,
            title: input.title,
            prompt: input.prompt,
            scheduleKind,
            scheduleLabel: input.scheduleLabel,
            cronExpression: input.cronExpression,
            timezone: input.timezone,
            runAt: input.runAt,
            nextRunAt,
            updatedAt: new Date().toISOString(),
          });

          if (input.title !== undefined) {
            yield* context
              .dispatchNormalizedCommand({
                type: "thread.meta.update",
                commandId: CommandId.makeUnsafe(
                  `server:automation-thread-title:${crypto.randomUUID()}`,
                ),
                threadId: current.value.targetThreadId,
                title: input.title,
              })
              .pipe(Effect.ignore);
          }

          return { automation };
        }).pipe(
          Effect.mapError((cause) => toAutomationError(cause, "Failed to update automation")),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverPauseAutomation]: (input: typeof ServerPauseAutomationInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverPauseAutomation,
        Effect.gen(function* () {
          const current = yield* context.automationScheduleRepository.getById({
            automationId: input.automationId,
          });
          if (Option.isNone(current) || current.value.deletedAt !== null) {
            return yield* new ServerAutomationError({
              message: "Automation not found",
            });
          }
          if (current.value.pausedAt !== null || current.value.completedAt !== null) {
            return yield* new ServerAutomationError({
              message: "Automation not found",
            });
          }

          yield* context.automationScheduleRepository.pause({
            automationId: input.automationId,
            pausedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }).pipe(Effect.mapError((cause) => toAutomationError(cause, "Failed to pause automation"))),
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
          if (current.value.pausedAt === null || current.value.completedAt !== null) {
            return yield* new ServerAutomationError({
              message: "Automation not found",
            });
          }

          const nextRunAt = yield* resolveNextRunAt({
            cronExpression: current.value.cronExpression,
            runAt: current.value.runAt,
            scheduleKind: current.value.scheduleKind,
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
        Effect.gen(function* () {
          const current = yield* context.automationScheduleRepository.getById({
            automationId: input.automationId,
          });
          if (Option.isNone(current) || current.value.deletedAt !== null) {
            return yield* new ServerAutomationError({
              message: "Automation not found",
            });
          }

          const ownedTargetThread = yield* context.automationScheduleRepository.delete({
            automationId: input.automationId,
            deletedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          if (
            ownedTargetThread &&
            (yield* context.automationScheduleRepository.getOwningAutomationId(
              current.value.targetThreadId,
            )).pipe(Option.isNone)
          ) {
            yield* context.dispatchNormalizedCommand({
              type: "thread.delete",
              commandId: CommandId.makeUnsafe(
                `server:automation-owned-thread-delete:${crypto.randomUUID()}`,
              ),
              threadId: current.value.targetThreadId,
            });
          }
        }).pipe(
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

          const result = yield* context.schedulerReactor.triggerNow(input.automationId);
          if (result.status === "not_found") {
            return yield* new ServerAutomationError({
              message: "Automation not found",
            });
          }
          if (result.status === "paused_or_completed") {
            return yield* new ServerAutomationError({
              message: "Automation has already completed",
            });
          }
          if (result.status === "dispatch_failed") {
            return yield* new ServerAutomationError({
              message: "Failed to trigger automation",
            });
          }
          return {
            status: result.status,
            triggeredAt: result.triggeredAt,
            runId: result.runId,
          };
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
