import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import { Effect } from "effect";

import { updateThread } from "./projectorHelpers.ts";

type QueuedPromptEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.prompt-queued" | "thread.queued-prompt-removed" | "thread.queued-prompts-flushed";
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
    case "thread.queued-prompt-removed":
      return Effect.succeed({
        ...model,
        threads: updateThread(model.threads, event.payload.threadId, {
          queuedPrompts:
            model.threads
              .find((thread) => thread.id === event.payload.threadId)
              ?.queuedPrompts?.filter((prompt) => prompt.id !== event.payload.messageId) ?? [],
          updatedAt: event.occurredAt,
        }),
      });
    case "thread.queued-prompts-flushed": {
      const removed = new Set(event.payload.messageIds);
      const thread = model.threads.find((entry) => entry.id === event.payload.threadId);
      if (!thread) return Effect.succeed(model);
      return Effect.succeed({
        ...model,
        threads: updateThread(model.threads, thread.id, {
          queuedPrompts: (thread.queuedPrompts ?? []).filter((prompt) => !removed.has(prompt.id)),
          updatedAt: event.occurredAt,
        }),
      });
    }
  }
}
