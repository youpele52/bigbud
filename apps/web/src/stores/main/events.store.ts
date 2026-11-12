import { type OrchestrationEvent } from "@bigbud/contracts";
import { type AppState } from "./main.store";
import { applyProjectEvent } from "./events.store.projects";
import { applyThreadMetaEvent } from "./events.store.threads.meta";
import { applyThreadQueueEvent } from "./events.store.threads.queue";
import { applyThreadRuntimeEvent } from "./events.store.threads.runtime";
import { observeThreadNotification } from "../../notifications/taskCompletion.observations";
import { observeNotificationSafety } from "../../notifications/taskCompletion.safety";
import { observeDelegatedTurnBinding } from "../../notifications/taskCompletion.delegations";

export function applyOrchestrationEvent(state: AppState, event: OrchestrationEvent): AppState {
  const next =
    applyProjectEvent(state, event) ??
    applyThreadMetaEvent(state, event) ??
    applyThreadQueueEvent(state, event) ??
    applyThreadRuntimeEvent(state, event) ??
    state;
  if (!("threadId" in event.payload)) return next;
  const threadId = event.payload.threadId;
  const previous = state.threads.find((thread) => thread.id === threadId);
  return {
    ...next,
    threads: next.threads.map((thread) =>
      observeDelegatedTurnBinding(
        thread.id === threadId && previous
          ? observeThreadNotification(
              previous,
              observeNotificationSafety(previous, thread, event),
              event,
            )
          : thread,
        event,
      ),
    ),
  };
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  if (events.length === 0) return state;
  return events.reduce((nextState, event) => applyOrchestrationEvent(nextState, event), state);
}
