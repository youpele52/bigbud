import {
  CommandId,
  MessageId,
  type AssistantDeliveryMode,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type ServerSettingsError,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { toTurnId } from "./ProviderRuntimeIngestion.helpers.ts";
import type { makeProcessorHelpers } from "./ProviderRuntimeIngestion.processor.helpers.ts";
import type { makeThinkingProcessorHelpers } from "./ProviderRuntimeIngestion.processor.thinking.ts";
import type {
  RuntimeProcessorCacheHelpers,
  RuntimeProcessorServices,
} from "./ProviderRuntimeIngestion.processor.ts";

type ProcessorHelpers = ReturnType<typeof makeProcessorHelpers>;
type ThinkingProcessorHelpers = ReturnType<typeof makeThinkingProcessorHelpers>;

type AssistantCacheHelpers = Pick<
  RuntimeProcessorCacheHelpers,
  "appendBufferedAssistantText" | "forgetAssistantMessageId" | "rememberAssistantMessageId"
>;

type AssistantProcessorHelpers = Pick<ProcessorHelpers, "finalizeAssistantMessage">;
type AssistantThinkingHelpers = Pick<
  ThinkingProcessorHelpers,
  "finalizeThinkingForItem" | "finalizeThinkingForTurn"
>;

interface ProcessAssistantRuntimeEventInput {
  readonly event: ProviderRuntimeEvent;
  readonly thread: OrchestrationThread;
  readonly now: string;
  readonly orchestrationEngine: RuntimeProcessorServices["orchestrationEngine"];
  readonly providerCommandId: (event: ProviderRuntimeEvent, tag: string) => CommandId;
  readonly resolveDeliveryMode: () => Effect.Effect<AssistantDeliveryMode, ServerSettingsError>;
  readonly cacheHelpers: AssistantCacheHelpers;
  readonly processorHelpers: AssistantProcessorHelpers;
  readonly thinkingHelpers: AssistantThinkingHelpers;
}

/** Handles assistant deltas and completion independently of session lifecycle changes. */
export const processAssistantRuntimeEvent = Effect.fn("processAssistantRuntimeEvent")(function* (
  input: ProcessAssistantRuntimeEventInput,
) {
  const { event, thread, now, orchestrationEngine } = input;
  const assistantDelta =
    event.type === "content.delta" && event.payload.streamKind === "assistant_text"
      ? event.payload.delta
      : undefined;

  if (assistantDelta && assistantDelta.length > 0) {
    const assistantMessageId = MessageId.makeUnsafe(
      `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
    );
    const turnId = toTurnId(event.turnId);
    if (turnId) {
      yield* input.cacheHelpers.rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
    }

    const assistantDeliveryMode = yield* input.resolveDeliveryMode();
    if (assistantDeliveryMode === "buffered") {
      const spillChunk = yield* input.cacheHelpers.appendBufferedAssistantText(
        assistantMessageId,
        assistantDelta,
      );
      if (spillChunk.length > 0) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: input.providerCommandId(event, "assistant-delta-buffer-spill"),
          threadId: thread.id,
          messageId: assistantMessageId,
          delta: spillChunk,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
        });
      }
    } else {
      const coalescedDelta = yield* input.cacheHelpers.appendBufferedAssistantText(
        assistantMessageId,
        assistantDelta,
        true,
      );
      if (coalescedDelta.length === 0) {
        return;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: input.providerCommandId(event, "assistant-delta"),
        threadId: thread.id,
        messageId: assistantMessageId,
        delta: coalescedDelta,
        ...(turnId ? { turnId } : {}),
        createdAt: now,
      });
    }
  }

  if (event.type !== "item.completed" || event.payload.itemType !== "assistant_message") {
    return;
  }

  const turnId = toTurnId(event.turnId);
  if (turnId) {
    yield* input.thinkingHelpers.finalizeThinkingForTurn(event, thread.id, turnId);
  } else if (event.itemId) {
    yield* input.thinkingHelpers.finalizeThinkingForItem(event, String(event.itemId));
  }

  const messageId = MessageId.makeUnsafe(
    `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
  );
  const existingMessage = thread.messages.find((entry) => entry.id === messageId);
  const fallbackText = event.payload.detail;
  if (turnId) {
    yield* input.cacheHelpers.rememberAssistantMessageId(thread.id, turnId, messageId);
  }

  yield* input.processorHelpers.finalizeAssistantMessage({
    event,
    threadId: thread.id,
    messageId,
    ...(turnId ? { turnId } : {}),
    createdAt: now,
    commandTag: "assistant-complete",
    finalDeltaCommandTag: "assistant-delta-finalize",
    ...(fallbackText !== undefined && (!existingMessage || existingMessage.text.length === 0)
      ? { fallbackText }
      : {}),
  });

  if (turnId) {
    yield* input.cacheHelpers.forgetAssistantMessageId(thread.id, turnId, messageId);
  }
});
