import { type OrchestrationEvent } from "@bigbud/contracts";

import { updateThreadState } from "./helpers.store";
import { type AppState } from "./main.store";

export function applyThreadQueueEvent(
  state: AppState,
  event: OrchestrationEvent,
): AppState | undefined {
  switch (event.type) {
    case "thread.prompt-queued":
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const queuedPrompts = thread.queuedPrompts ?? [];
        if (queuedPrompts.some((prompt) => prompt.id === event.payload.prompt.id)) {
          return thread;
        }
        return {
          ...thread,
          queuedPrompts: [...queuedPrompts, event.payload.prompt],
          updatedAt: event.occurredAt,
        };
      });

    case "thread.queued-prompt-removed":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        queuedPrompts: (thread.queuedPrompts ?? []).filter(
          (prompt) => prompt.id !== event.payload.messageId,
        ),
        updatedAt: event.occurredAt,
      }));

    case "thread.queued-prompts-flushed": {
      const flushedMessageIds = new Set(event.payload.messageIds);
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        queuedPrompts: (thread.queuedPrompts ?? []).filter(
          (prompt) => !flushedMessageIds.has(prompt.id),
        ),
        updatedAt: event.occurredAt,
      }));
    }

    default:
      return undefined;
  }
}
