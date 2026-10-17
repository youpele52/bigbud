import type { OrchestrationEvent } from "@bigbud/contracts";

import type { AppState } from "./main.store";

type WorkflowState = "idle" | "working" | "failed";

function runtimeState(event: OrchestrationEvent): WorkflowState | undefined {
  switch (event.type) {
    case "thread.session-set":
      if (event.payload.session.status === "error") return "failed";
      return event.payload.session.status === "running" ||
        event.payload.session.status === "starting"
        ? "working"
        : "idle";
    case "thread.turn-start-requested":
      return "working";
    case "thread.turn-start-failed":
      return "failed";
    default:
      return undefined;
  }
}

export function applyDelegatedChildRuntimeEvent(
  state: AppState,
  event: OrchestrationEvent,
): AppState {
  const workflowState = runtimeState(event);
  if (!workflowState || !("threadId" in event.payload)) return state;
  const childThreadId = event.payload.threadId;
  let changed = false;
  const threads = state.threads.map((thread) => {
    if (!thread.delegatedChildren?.some((child) => child.threadId === childThreadId)) return thread;
    changed = true;
    return {
      ...thread,
      delegatedChildren: thread.delegatedChildren.map((child) =>
        child.threadId === childThreadId
          ? { ...child, workflowState, updatedAt: event.occurredAt }
          : child,
      ),
    };
  });
  return changed ? { ...state, threads } : state;
}
