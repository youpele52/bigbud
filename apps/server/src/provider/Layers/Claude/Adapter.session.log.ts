import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderItemId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import { claudeSdkDiagnostic } from "./Adapter.sdk.projections.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { asCanonicalTurnId, sdkNativeItemId, sdkNativeMethod } from "./Adapter.utils.ts";

/** Logs a bounded SDK diagnostic to the native event log when enabled. */
export function makeLogNativeSdkMessage(nativeEventLogger: EventNdjsonLogger | undefined) {
  return Effect.fn("logNativeSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) return;
    const observedAt = new Date().toISOString();
    const itemId = sdkNativeItemId(message);
    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : crypto.randomUUID(),
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
          payload: claudeSdkDiagnostic(message),
        },
      },
      context.session.threadId,
    );
  });
}
