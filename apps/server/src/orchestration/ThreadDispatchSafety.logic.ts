import type { OrchestrationThread } from "@bigbud/contracts";

import { resolveThreadWorkflowStatus } from "./ThreadWorkflowStatus.logic.ts";

export function hasActiveThreadTurnOrSession(thread: OrchestrationThread): boolean {
  return (
    thread.session?.activeTurnId != null ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  );
}

export function isThreadTurnDispatchBlocked(thread: OrchestrationThread): boolean {
  if (hasActiveThreadTurnOrSession(thread)) return true;
  const workflow = resolveThreadWorkflowStatus(thread);
  return workflow.hasPendingApprovals || workflow.hasPendingUserInput;
}

// Direct thread.turn.start still needs its own durable pending-start gate; that
// separate race is intentionally outside this snapshot-level dispatch policy.
export function isThreadConfirmedIdleForDispatch(thread: OrchestrationThread): boolean {
  return !isThreadTurnDispatchBlocked(thread);
}
