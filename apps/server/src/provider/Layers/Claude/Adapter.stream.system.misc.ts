/**
 * Claude SDK 0.3.301 system and top-level messages that are not turn, task or hook output:
 * informational no-ops (counted by a metric), permission denials, plugin installs, worker
 * shutdown and `conversation_reset`.
 *
 * Nothing here resends, replays or restarts; `conversation_reset` only drops the native
 * resume anchor, because the old assistant UUIDs are not in the new native transcript.
 *
 * @module ClaudeAdapter.stream.system.misc
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  claudeSdkMessageMetricAttributes,
  claudeSdkMessagesTotal,
} from "../../../observability/Metrics.claudeSdk.ts";
import { increment } from "../../../observability/Metrics.ts";
import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import { asRecord } from "./Adapter.sdk.messages.ts";
import type { TurnHandlers } from "./Adapter.stream.turn.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";

const NO_OP_SYSTEM_SUBTYPES = new Set([
  "thinking_tokens",
  "informational",
  "notification",
  "session_state_changed",
  "memory_recall",
  "local_command_output",
  "mirror_error",
]);

const RESET_TRIGGERS = new Set(["clear", "plan_mode_exit", "fresh_session", "onboarding"]);

type RuntimeEventBase = Omit<ProviderRuntimeEvent, "type" | "payload">;

const text = (value: unknown, max = 500): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

export const countClaudeSdkMessage = (kind: string) =>
  increment(claudeSdkMessagesTotal, claudeSdkMessageMetricAttributes(kind));

export function makeMiscSystemHandlers(deps: {
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  readonly turn: TurnHandlers;
}) {
  const { offerRuntimeEvent, turn } = deps;

  /** Returns whether the system message was handled here. */
  const handleMiscSystemMessage = Effect.fn("handleClaudeMiscSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
    base: RuntimeEventBase,
  ) {
    const record = asRecord(message);
    const subtype = typeof record?.subtype === "string" ? record.subtype : "";
    if (NO_OP_SYSTEM_SUBTYPES.has(subtype)) {
      yield* countClaudeSdkMessage(subtype);
      return true;
    }
    switch (subtype) {
      case "permission_denied": {
        const tool = text(record?.tool_name, 80) ?? "tool";
        const reason = text(record?.decision_reason) ?? text(record?.message) ?? "denied";
        yield* turn.emitRuntimeWarning(context, `Claude denied ${tool}: ${reason}`, {
          toolName: tool,
          ...(text(record?.tool_use_id) ? { toolUseId: text(record?.tool_use_id) } : {}),
          ...(text(record?.decision_reason_type, 40)
            ? { decisionReasonType: text(record?.decision_reason_type, 40) }
            : {}),
          ...(text(record?.agent_id) ? { agentId: text(record?.agent_id) } : {}),
        });
        return true;
      }
      case "plugin_install": {
        yield* countClaudeSdkMessage("plugin_install");
        if (record?.status === "failed") {
          const name = text(record.name, 120) ?? "plugin";
          const error = text(record.error) ?? "unknown error";
          yield* turn.emitRuntimeWarning(
            context,
            `Claude plugin install failed for ${name}: ${error}`,
            { name, error },
          );
        }
        return true;
      }
      case "worker_shutting_down": {
        const reason = text(record?.reason, 80) ?? "unspecified";
        // Not session death: stream-end recovery stays authoritative, nothing is resent.
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "session.state.changed",
          payload: { state: "waiting", reason: `worker_shutting_down:${reason}` },
        } as ProviderRuntimeEvent);
        return true;
      }
      default:
        return false;
    }
  });

  /** `conversation_reset`: drop the stale resume anchor and record the reset. */
  const handleConversationReset = Effect.fn("handleClaudeConversationReset")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
    base: RuntimeEventBase,
  ) {
    const record = asRecord(message);
    context.lastAssistantUuid = undefined;
    // Keep resumeSessionId; ensureThreadId adopts the new session_id from later frames.
    yield* turn.updateResumeCursor(context);
    const trigger =
      typeof record?.trigger === "string" && RESET_TRIGGERS.has(record.trigger)
        ? record.trigger
        : "unspecified";
    const newConversationId = text(record?.new_conversation_id, 80);
    yield* offerRuntimeEvent(context, {
      ...base,
      type: "thread.state.changed",
      payload: {
        state: "reset",
        detail: { trigger, ...(newConversationId ? { newConversationId } : {}) },
      },
    } as ProviderRuntimeEvent);
  });

  return { handleMiscSystemMessage, handleConversationReset };
}
