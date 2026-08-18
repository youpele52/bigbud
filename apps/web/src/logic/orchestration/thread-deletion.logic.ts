import type { OrchestrationEvent, ThreadId } from "@bigbud/contracts";

export function getDeletedThreadIds(
  payload: Extract<OrchestrationEvent, { type: "thread.deleted" }>["payload"],
): readonly ThreadId[] {
  return payload.threadIds ?? [payload.threadId];
}
