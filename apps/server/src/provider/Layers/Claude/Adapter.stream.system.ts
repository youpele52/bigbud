import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventId } from "@bigbud/contracts";
import { Effect } from "effect";

import { asCanonicalTurnId, nativeProviderRefs, sdkNativeMethod } from "./Adapter.utils.ts";
import {
  asRecord,
  decodeClaudeApiRetryMessage,
  decodeClaudeCommandsChangedMessage,
  decodeClaudeElicitationCompleteMessage,
  decodeClaudeHookMessage,
  decodeClaudeMcpInitialization,
  decodeClaudeRefusalMessage,
} from "./Adapter.sdk.messages.ts";
import { claudeSdkDiagnostic, claudeSdkRuntimeRaw } from "./Adapter.sdk.projections.ts";
import { CLAUDE_AGENT_SDK_VERSION, claudeSdkMessageLabel } from "./Adapter.sdk.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { TurnHandlers } from "./Adapter.stream.turn.ts";
import { isClaudeTaskSystemMessage, makeTaskSystemHandler } from "./Adapter.stream.system.tasks.ts";
import { normalizeMcpServerStatuses, redactedMcpRuntimePayload } from "../../providerMcp.ts";
import { makeSdkTelemetryHandler } from "./Adapter.stream.system.telemetry.ts";
import type { SubagentHandlers } from "./Adapter.stream.subagents.ts";
import { countClaudeSdkMessage, makeMiscSystemHandlers } from "./Adapter.stream.system.misc.ts";
import { makeClaudePromptSuggestionHandler } from "./Adapter.stream.promptSuggestion.ts";

export interface SystemHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  readonly nowIso: Effect.Effect<string>;
  readonly turn: TurnHandlers;
  readonly subagents: SubagentHandlers;
}

export const makeSystemHandlers = (deps: SystemHandlerDeps) => {
  const { makeEventStamp, offerRuntimeEvent, nowIso, turn, subagents } = deps;
  const handleSdkTelemetryMessage = makeSdkTelemetryHandler({
    makeEventStamp,
    offerRuntimeEvent,
    turn,
    subagents,
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

  const misc = makeMiscSystemHandlers({ offerRuntimeEvent, turn });
  const handleTaskSystemMessage = makeTaskSystemHandler({
    makeEventStamp,
    offerRuntimeEvent,
    nowIso,
    invalid,
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

    if (isClaudeTaskSystemMessage(message)) {
      return yield* handleTaskSystemMessage(context, message, base);
    }
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
            config: {
              sdkVersion: CLAUDE_AGENT_SDK_VERSION,
              mcpServerCount: status.length,
              ...(typeof message.claude_code_version === "string"
                ? { claudeCodeVersion: message.claude_code_version.slice(0, 40) }
                : {}),
            },
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
        // ClaudeProviderRefreshReactor refreshes the provider's slash commands from this.
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "session.configured",
          payload: { config: { commandsChanged: true, commandCount: commands.commands.length } },
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
        if (yield* misc.handleMiscSystemMessage(context, message, base)) return;
        yield* turn.emitRuntimeWarning(
          context,
          `Unhandled Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} system message '${claudeSdkMessageLabel(message)}'.`,
          claudeSdkDiagnostic(message),
        );
    }
  });

  const handlePromptSuggestion = makeClaudePromptSuggestionHandler({ offerRuntimeEvent });
  /** Top-level `conversation_reset` and `prompt_suggestion` frames. */
  const handleTopLevelMessage = Effect.fn("handleClaudeTopLevelMessage")(function* (
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
      raw: claudeSdkRuntimeRaw(message, sdkNativeMethod(message)),
    };
    if (message.type === "conversation_reset") {
      return yield* misc.handleConversationReset(context, message, base);
    }
    yield* countClaudeSdkMessage("prompt_suggestion");
    // Mapped for the settled turn; never sent automatically.
    yield* handlePromptSuggestion(context, message, base);
  });
  return { handleSystemMessage, handleSdkTelemetryMessage, handleTopLevelMessage };
};
export type SystemHandlers = ReturnType<typeof makeSystemHandlers>;
