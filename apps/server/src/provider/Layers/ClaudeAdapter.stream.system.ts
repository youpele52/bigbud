/**
 * ClaudeAdapter system and telemetry message handlers.
 *
 * Handles `system` and telemetry SDK messages (tool_progress, tool_use_summary,
 * auth_status, rate_limit_event), projecting them into canonical runtime events.
 *
 * @module ClaudeAdapter.stream.system
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type EventId, RuntimeTaskId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  asCanonicalTurnId,
  nativeProviderRefs,
  normalizeClaudeTokenUsage,
  sdkNativeMethod,
} from "./ClaudeAdapter.utils.ts";
import type { ClaudeSessionContext } from "./ClaudeAdapter.types.ts";
import { PROVIDER } from "./ClaudeAdapter.types.ts";
import type { TurnHandlers } from "./ClaudeAdapter.stream.turn.ts";

export interface SystemHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly turn: TurnHandlers;
}

export const makeSystemHandlers = (deps: SystemHandlerDeps) => {
  const { makeEventStamp, offerRuntimeEvent, turn } = deps;

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    switch (message.subtype) {
      case "init":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });
        return;
      case "status":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason:
              message.status === "compacting"
                ? "context.compacting"
                : `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        return;
      case "compact_boundary":
        yield* offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });
        return;
      case "hook_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "task_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            description: message.description,
            ...(message.task_type ? { taskType: message.task_type } : {}),
          },
        });
        return;
      case "task_progress":
        if (message.usage) {
          const normalizedUsage = normalizeClaudeTokenUsage(
            message.usage,
            context.lastKnownContextWindow,
          );
          if (normalizedUsage) {
            context.lastKnownTokenUsage = normalizedUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              eventId: usageStamp.eventId,
              createdAt: usageStamp.createdAt,
              type: "thread.token-usage.updated",
              payload: {
                usage: normalizedUsage,
              },
            });
          }
        }
        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
          },
        });
        return;
      case "task_notification":
        if (message.usage) {
          const normalizedUsage = normalizeClaudeTokenUsage(
            message.usage,
            context.lastKnownContextWindow,
          );
          if (normalizedUsage) {
            context.lastKnownTokenUsage = normalizedUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              eventId: usageStamp.eventId,
              createdAt: usageStamp.createdAt,
              type: "thread.token-usage.updated",
              payload: {
                usage: normalizedUsage,
              },
            });
          }
        }
        yield* offerRuntimeEvent({
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
          },
        });
        return;
      case "files_persisted":
        yield* offerRuntimeEvent({
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      default:
        yield* turn.emitRuntimeWarning(
          context,
          `Unhandled Claude system message subtype '${message.subtype}'.`,
          message,
        );
        return;
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? { precedingToolUseIds: message.preceding_tool_use_ids }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEvent({
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      yield* offerRuntimeEvent({
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      return;
    }
  });

  return {
    handleSystemMessage,
    handleSdkTelemetryMessage,
  };
};

export type SystemHandlers = ReturnType<typeof makeSystemHandlers>;
