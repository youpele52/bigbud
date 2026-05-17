import { type OrchestrationEvent } from "@bigbud/contracts";
import { type AppState } from "./main.store";
import { applyProjectEvent } from "./events.store.projects";
import { applyThreadMetaEvent } from "./events.store.threads.meta";
import { applyThreadRuntimeEvent } from "./events.store.threads.runtime";

export function applyOrchestrationEvent(state: AppState, event: OrchestrationEvent): AppState {
  const projectState = applyProjectEvent(state, event);
  if (projectState !== undefined) {
    return projectState;
  }

  const threadMetaState = applyThreadMetaEvent(state, event);
  if (threadMetaState !== undefined) {
    return threadMetaState;
  }

  const threadRuntimeState = applyThreadRuntimeEvent(state, event);
  if (threadRuntimeState !== undefined) {
    return threadRuntimeState;
  }

  return state;
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  if (events.length === 0) {
    return state;
  }
  return events.reduce((nextState, event) => applyOrchestrationEvent(nextState, event), state);
}
