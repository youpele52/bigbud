import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import { claudeSdkDiagnostic, claudeSdkRuntimeRaw } from "./Adapter.sdk.projections.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { asCanonicalTurnId, nativeProviderRefs, sdkNativeMethod } from "./Adapter.utils.ts";
import type { TurnHandlers } from "./Adapter.stream.turn.ts";

export function makeSdkTelemetryHandler(deps: {
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  readonly turn: TurnHandlers;
}) {
  return Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* deps.makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: claudeSdkRuntimeRaw(message, sdkNativeMethod(message)),
    };
    if (message.type === "tool_progress") {
      yield* deps.offerRuntimeEvent(context, {
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      });
    } else if (message.type === "tool_use_summary") {
      yield* deps.offerRuntimeEvent(context, {
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? { precedingToolUseIds: message.preceding_tool_use_ids }
            : {}),
        },
      });
    } else if (message.type === "auth_status") {
      yield* deps.offerRuntimeEvent(context, {
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
    } else if (message.type === "rate_limit_event") {
      yield* deps.turn.emitRuntimeWarning(
        context,
        "Claude rate-limit status changed.",
        claudeSdkDiagnostic(message),
      );
    }
  });
}
