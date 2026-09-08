import { Effect, Option } from "effect";
import {
  AutomationId,
  CommandId,
  ServerAutomationError,
  ServerCreateAutomationInput,
  ServerCreateOwnedAutomationInput,
  ThreadId,
  WS_METHODS,
} from "@bigbud/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { WsRpcContext } from "./wsRpcContext";
import {
  DEFAULT_AUTOMATION_TIMEZONE,
  resolveNextRunAt,
  toAutomationError,
} from "./wsRpcHandlers.automation.shared.ts";

function createSchedule(
  context: WsRpcContext,
  input: {
    readonly projectId: ServerCreateAutomationInput["projectId"];
    readonly targetThreadId: ServerCreateAutomationInput["targetThreadId"];
    readonly title: ServerCreateAutomationInput["title"];
    readonly prompt: ServerCreateAutomationInput["prompt"];
    readonly scheduleKind: ServerCreateAutomationInput["scheduleKind"];
    readonly scheduleLabel: ServerCreateAutomationInput["scheduleLabel"];
    readonly cronExpression: ServerCreateAutomationInput["cronExpression"];
    readonly timezone?: ServerCreateAutomationInput["timezone"];
    readonly runAt?: ServerCreateAutomationInput["runAt"];
    readonly ownsTargetThread: boolean;
  },
) {
  return Effect.gen(function* () {
    const timezone = input.timezone ?? DEFAULT_AUTOMATION_TIMEZONE;
    const nextRunAt = yield* resolveNextRunAt({
      cronExpression: input.cronExpression,
      runAt: input.runAt ?? null,
      scheduleKind: input.scheduleKind,
      timezone,
      now: new Date(),
    });
    return yield* context.automationScheduleRepository.create({
      automationId: AutomationId.makeUnsafe(crypto.randomUUID()),
      ...input,
      timezone,
      runAt: input.runAt ?? null,
      nextRunAt,
    });
  });
}

export function makeWsRpcAutomationCreateHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverCreateAutomation]: (input: typeof ServerCreateAutomationInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverCreateAutomation,
        Effect.gen(function* () {
          const thread = yield* context.projectionThreadRepository.getById({
            threadId: input.targetThreadId,
          });
          if (
            Option.isNone(thread) ||
            thread.value.deletedAt !== null ||
            thread.value.projectId !== input.projectId
          ) {
            return yield* new ServerAutomationError({
              message: "Automation thread not found",
            });
          }

          const automation = yield* createSchedule(context, {
            ...input,
            ownsTargetThread: false,
          });

          yield* context
            .dispatchNormalizedCommand(
              {
                type: "thread.meta.update",
                commandId: CommandId.makeUnsafe(
                  `server:automation-thread-title:${crypto.randomUUID()}`,
                ),
                threadId: input.targetThreadId,
                title: input.title,
              },
              "automation",
            )
            .pipe(Effect.ignore);

          return { automation };
        }).pipe(
          Effect.mapError((cause) => toAutomationError(cause, "Failed to create automation")),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverCreateOwnedAutomation]: (
      input: typeof ServerCreateOwnedAutomationInput.Type,
    ) =>
      observeRpcEffect(
        WS_METHODS.serverCreateOwnedAutomation,
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
          const createdAt = new Date().toISOString();
          yield* context.dispatchNormalizedCommand(
            {
              type: "thread.create",
              commandId: CommandId.makeUnsafe(
                `server:automation-thread-create:${crypto.randomUUID()}`,
              ),
              threadId,
              projectId: input.projectId,
              title: input.title,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: input.branch,
              worktreePath: input.worktreePath,
              createdAt,
              ...(input.providerRuntimeExecutionTargetId
                ? { providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId }
                : {}),
              ...(input.workspaceExecutionTargetId
                ? { workspaceExecutionTargetId: input.workspaceExecutionTargetId }
                : {}),
              ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
            },
            "automation",
          );
          const automation = yield* createSchedule(context, {
            ...input,
            targetThreadId: threadId,
            ownsTargetThread: true,
          }).pipe(
            Effect.tapError(() =>
              context
                .dispatchNormalizedCommand(
                  {
                    type: "thread.delete",
                    commandId: CommandId.makeUnsafe(
                      `server:automation-thread-create-compensation:${crypto.randomUUID()}`,
                    ),
                    threadId,
                  },
                  "automation",
                )
                .pipe(Effect.ignore),
            ),
          );
          return { automation };
        }).pipe(
          Effect.mapError((cause) =>
            toAutomationError(cause, "Failed to create automation-owned thread"),
          ),
        ),
        { "rpc.aggregate": "server" },
      ),
  };
}
