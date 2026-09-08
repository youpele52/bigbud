import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type EventId, RuntimeTaskId } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  asCanonicalTurnId,
  nativeProviderRefs,
  normalizeClaudeTokenUsage,
  sdkNativeMethod,
} from "./Adapter.utils.ts";
import {
  asRecord,
  decodeClaudeApiRetryMessage,
  decodeClaudeBackgroundTasksChangedMessage,
  decodeClaudeCommandsChangedMessage,
  decodeClaudeElicitationCompleteMessage,
  decodeClaudeHookMessage,
  decodeClaudeMcpInitialization,
  decodeClaudeRefusalMessage,
  decodeClaudeTaskNotificationMessage,
  decodeClaudeTaskProgressMessage,
  decodeClaudeTaskStartedMessage,
  decodeClaudeTaskUpdatedMessage,
} from "./Adapter.sdk.messages.ts";
import { claudeSdkDiagnostic, claudeSdkRuntimeRaw } from "./Adapter.sdk.projections.ts";
import { CLAUDE_AGENT_SDK_VERSION, claudeSdkMessageLabel } from "./Adapter.sdk.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { TurnHandlers } from "./Adapter.stream.turn.ts";
import { updateClaudeTaskPlan } from "./Adapter.stream.tasks.ts";
import { normalizeMcpServerStatuses, redactedMcpRuntimePayload } from "../../providerMcp.ts";
import { makeSdkTelemetryHandler } from "./Adapter.stream.system.telemetry.ts";

export interface SystemHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  readonly nowIso: Effect.Effect<string>;
  readonly turn: TurnHandlers;
}

export const makeSystemHandlers = (deps: SystemHandlerDeps) => {
  const { makeEventStamp, offerRuntimeEvent, nowIso, turn } = deps;
  const handleSdkTelemetryMessage = makeSdkTelemetryHandler({
    makeEventStamp,
    offerRuntimeEvent,
    turn,
  });
  const invalid = Effect.fn("invalidClaudeSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* turn.emitRuntimeWarning(
      context,
      `Invalid Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} ${claudeSdkMessageLabel(message)} message.`,
      claudeSdkDiagnostic(message),
    );
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") return;
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: claudeSdkRuntimeRaw(message, sdkNativeMethod(message)),
    };

    switch (message.subtype) {
      case "init": {
        const init = decodeClaudeMcpInitialization(message);
        if (!init) return yield* invalid(context, message);
        const status = normalizeMcpServerStatuses(init.servers);
        context.mcpStatuses = status;
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "session.configured",
          payload: {
            config: { sdkVersion: CLAUDE_AGENT_SDK_VERSION, mcpServerCount: status.length },
          },
        });
        const mcpStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          ...base,
          eventId: mcpStamp.eventId,
          createdAt: mcpStamp.createdAt,
          type: "mcp.status.updated",
          payload: redactedMcpRuntimePayload(status),
        });
        return;
      }
      case "status":
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: message.status === "compacting" ? "context.compacting" : "status:active",
          },
        });
        return;
      case "compact_boundary":
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "thread.state.changed",
          payload: { state: "compacted", detail: { trigger: message.compact_metadata.trigger } },
        });
        return;
      case "hook_started":
      case "hook_progress":
      case "hook_response": {
        const hook = decodeClaudeHookMessage(message);
        if (!hook) return yield* invalid(context, message);
        if (hook.subtype === "hook_started") {
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "hook.started",
            payload: { hookId: hook.hookId, hookName: hook.hookName, hookEvent: hook.hookEvent },
          });
        } else if (hook.subtype === "hook_progress") {
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "hook.progress",
            payload: {
              hookId: hook.hookId,
              ...(hook.output !== undefined ? { output: hook.output } : {}),
              ...(hook.stdout !== undefined ? { stdout: hook.stdout } : {}),
              ...(hook.stderr !== undefined ? { stderr: hook.stderr } : {}),
            },
          });
        } else {
          const outcome = hook.outcome;
          if (!outcome) return yield* invalid(context, message);
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "hook.completed",
            payload: {
              hookId: hook.hookId,
              outcome,
              ...(hook.output !== undefined ? { output: hook.output } : {}),
              ...(hook.stdout !== undefined ? { stdout: hook.stdout } : {}),
              ...(hook.stderr !== undefined ? { stderr: hook.stderr } : {}),
              ...(hook.exitCode !== undefined ? { exitCode: hook.exitCode } : {}),
            },
          });
        }
        return;
      }
      case "task_started": {
        const task = decodeClaudeTaskStartedMessage(message);
        if (!task) return yield* invalid(context, message);
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "task.started",
          payload: { taskId: RuntimeTaskId.makeUnsafe(task.taskId), description: task.description },
        });
        return;
      }
      case "task_progress": {
        const task = decodeClaudeTaskProgressMessage(message);
        if (!task) return yield* invalid(context, message);
        const normalizedUsage = task.usage
          ? normalizeClaudeTokenUsage(
              {
                total_tokens: task.usage.totalTokens,
                tool_uses: task.usage.toolUses,
                duration_ms: task.usage.durationMs,
              },
              context.lastKnownContextWindow,
            )
          : undefined;
        if (normalizedUsage) {
          context.lastKnownTokenUsage = normalizedUsage;
          const usageStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            ...base,
            eventId: usageStamp.eventId,
            createdAt: usageStamp.createdAt,
            type: "thread.token-usage.updated",
            payload: { usage: normalizedUsage },
          });
        }
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(task.taskId),
            description: task.description,
            ...(task.summary ? { summary: task.summary } : {}),
            ...(task.usage ? { usage: task.usage } : {}),
            ...(task.lastToolName ? { lastToolName: task.lastToolName } : {}),
          },
        });
        return;
      }
      case "task_notification": {
        const task = decodeClaudeTaskNotificationMessage(message);
        if (!task) return yield* invalid(context, message);
        const normalizedUsage = task.usage
          ? normalizeClaudeTokenUsage(
              {
                total_tokens: task.usage.totalTokens,
                tool_uses: task.usage.toolUses,
                duration_ms: task.usage.durationMs,
              },
              context.lastKnownContextWindow,
            )
          : undefined;
        if (normalizedUsage) {
          context.lastKnownTokenUsage = normalizedUsage;
          const usageStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            ...base,
            eventId: usageStamp.eventId,
            createdAt: usageStamp.createdAt,
            type: "thread.token-usage.updated",
            payload: { usage: normalizedUsage },
          });
        }
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(task.taskId),
            status: task.status,
            summary: task.summary,
            ...(task.usage ? { usage: task.usage } : {}),
          },
        });
        yield* updateClaudeTaskPlan({
          context,
          toolUseId: task.toolUseId ?? task.taskId,
          toolName: "task_notification",
          input: {
            uuid: task.uuid,
            task_id: task.taskId,
            status: task.status,
            summary: task.summary,
            ...(task.usage ? { usage: task.usage } : {}),
          },
          now: yield* nowIso,
          makeEventStamp,
          offerRuntimeEvent,
        });
        return;
      }
      case "task_updated": {
        const task = decodeClaudeTaskUpdatedMessage(message);
        if (!task) return yield* invalid(context, message);
        yield* updateClaudeTaskPlan({
          context,
          toolUseId: task.taskId,
          toolName: "task_updated",
          input: { task_id: task.taskId, patch: task.patch },
          now: yield* nowIso,
          makeEventStamp,
          offerRuntimeEvent,
        });
        return;
      }
      case "background_tasks_changed": {
        const snapshot = decodeClaudeBackgroundTasksChangedMessage(message);
        if (!snapshot) return yield* invalid(context, message);
        yield* updateClaudeTaskPlan({
          context,
          toolUseId: snapshot.uuid,
          toolName: "background_tasks_changed",
          input: {
            uuid: snapshot.uuid,
            tasks: snapshot.tasks.map((task) => ({
              task_id: task.taskId,
              task_type: task.taskType,
              description: task.description,
            })),
          },
          authoritativeSnapshot: true,
          now: yield* nowIso,
          makeEventStamp,
          offerRuntimeEvent,
        });
        return;
      }
      case "api_retry": {
        const retry = decodeClaudeApiRetryMessage(message);
        if (!retry) return yield* invalid(context, message);
        yield* turn.emitRuntimeWarning(context, "Claude API request retry scheduled.", {
          attempt: retry.attempt,
          maxRetries: retry.maxRetries,
          retryDelayMs: retry.retryDelayMs,
          errorStatus: retry.errorStatus,
        });
        return;
      }
      case "model_refusal_fallback": {
        const refusal = decodeClaudeRefusalMessage(message);
        if (!refusal?.fallbackModel) return yield* invalid(context, message);
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "model.rerouted",
          payload: {
            fromModel: refusal.originalModel,
            toModel: refusal.fallbackModel,
            reason: "model_refusal_fallback",
          },
        });
        return;
      }
      case "model_refusal_no_fallback": {
        const refusal = decodeClaudeRefusalMessage(message);
        if (!refusal) return yield* invalid(context, message);
        yield* turn.emitRuntimeWarning(
          context,
          "Claude model refusal has no configured fallback.",
          {
            category: refusal.category ?? null,
          },
        );
        return;
      }
      case "commands_changed": {
        const commands = decodeClaudeCommandsChangedMessage(message);
        if (!commands) return yield* invalid(context, message);
        yield* turn.emitRuntimeWarning(context, "Claude command list changed.", {
          commandCount: commands.commands.length,
        });
        return;
      }
      case "elicitation_complete": {
        const completion = decodeClaudeElicitationCompleteMessage(message);
        if (!completion) return yield* invalid(context, message);
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "mcp.oauth.completed",
          payload: { success: true, name: completion.serverName },
        });
        return;
      }
      case "files_persisted": {
        const record = asRecord(message);
        const files = Array.isArray(record?.files)
          ? record.files.flatMap((file) => {
              const value = asRecord(file);
              return typeof value?.filename === "string" && typeof value.file_id === "string"
                ? [{ filename: value.filename, fileId: value.file_id }]
                : [];
            })
          : [];
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "files.persisted",
          payload: { files },
        });
        return;
      }
      default:
        yield* turn.emitRuntimeWarning(
          context,
          `Unhandled Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} system message '${claudeSdkMessageLabel(message)}'.`,
          claudeSdkDiagnostic(message),
        );
    }
  });
  return { handleSystemMessage, handleSdkTelemetryMessage };
};
export type SystemHandlers = ReturnType<typeof makeSystemHandlers>;
