import { insertQueuedPrompt } from "@bigbud/shared/queuedPromptOrder";
import { type OrchestrationEvent } from "@bigbud/contracts";

import { updateThreadState } from "./helpers.store";
import { clearPendingTurnStartRequest } from "./events.store.threads.turnStartRequest";
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
          queuedPrompts: insertQueuedPrompt(
            queuedPrompts,
            event.payload.prompt,
            event.payload.queuePosition,
          ),
          // A busy turn start is re-queued as a prompt: it is no longer a pending start.
          turnStartRequest: clearPendingTurnStartRequest(
            thread.turnStartRequest,
            event.payload.prompt.id,
          ),
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
