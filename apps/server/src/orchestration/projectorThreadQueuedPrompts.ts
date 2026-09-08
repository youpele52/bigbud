import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import { Effect } from "effect";

import { updateThread } from "./projectorHelpers.ts";

type QueuedPromptEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.prompt-queued"
      | "thread.queued-prompt-removed"
      | "thread.queued-prompts-flushed"
      | "thread.queued-prompt-flush-cancelled";
  }
>;

export function projectThreadQueuedPromptEvent(
  model: OrchestrationReadModel,
  event: QueuedPromptEvent,
) {
  switch (event.type) {
    case "thread.prompt-queued": {
      const thread = model.threads.find((entry) => entry.id === event.payload.threadId);
      if (
        !thread ||
        thread.queuedPrompts?.some((prompt) => prompt.id === event.payload.prompt.id)
      ) {
        return Effect.succeed(model);
      }
      return Effect.succeed({
        ...model,
        threads: updateThread(model.threads, thread.id, {
          queuedPrompts: [...(thread.queuedPrompts ?? []), event.payload.prompt],
          updatedAt: event.occurredAt,
        }),
      });
    }
    case "thread.queued-prompt-removed": {
      const thread = model.threads.find((entry) => entry.id === event.payload.threadId);
      return Effect.succeed({
        ...model,
        threads: updateThread(model.threads, event.payload.threadId, {
          queuedPrompts:
            model.threads
              .find((thread) => thread.id === event.payload.threadId)
              ?.queuedPrompts?.filter((prompt) => prompt.id !== event.payload.messageId) ?? [],
          pendingInterruptFlushIntent:
            thread?.pendingInterruptFlushIntent?.queuedPromptIds.includes(event.payload.messageId)
              ? null
              : thread?.pendingInterruptFlushIntent,
          updatedAt: event.occurredAt,
        }),
      });
    }
    case "thread.queued-prompts-flushed": {
      const removed = new Set(event.payload.messageIds);
      const thread = model.threads.find((entry) => entry.id === event.payload.threadId);
      if (!thread) return Effect.succeed(model);
      return Effect.succeed({
        ...model,
        threads: updateThread(model.threads, thread.id, {
          queuedPrompts: (thread.queuedPrompts ?? []).filter((prompt) => !removed.has(prompt.id)),
          queueHold: false,
          pendingInterruptFlushIntent:
            thread.pendingInterruptFlushIntent !== null &&
            thread.pendingInterruptFlushIntent !== undefined &&
            thread.pendingInterruptFlushIntent.queuedPromptIds.length ===
              event.payload.messageIds.length &&
            thread.pendingInterruptFlushIntent.queuedPromptIds.every(
              (id, index) => id === event.payload.messageIds[index],
            )
              ? null
              : thread.pendingInterruptFlushIntent,
          updatedAt: event.occurredAt,
        }),
      });
    }
    case "thread.queued-prompt-flush-cancelled": {
      const thread = model.threads.find((entry) => entry.id === event.payload.threadId);
      if (!thread || thread.pendingInterruptFlushIntent?.intentId !== event.payload.intentId) {
        return Effect.succeed(model);
      }
      return Effect.succeed({
        ...model,
        threads: updateThread(model.threads, thread.id, {
          pendingInterruptFlushIntent: null,
          updatedAt: event.occurredAt,
        }),
      });
    }
  }
}
