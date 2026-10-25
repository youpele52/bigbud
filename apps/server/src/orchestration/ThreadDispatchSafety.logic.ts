import type { OrchestrationThread } from "@bigbud/contracts";
import { isLegacyOpencodeThread } from "@bigbud/shared/providerLifecycle";

import { hasPendingTurnStart } from "./PendingTurnStart.logic.ts";
import { resolveThreadWorkflowStatus } from "./ThreadWorkflowStatus.logic.ts";

export function hasActiveThreadTurnOrSession(thread: OrchestrationThread): boolean {
  return (
    thread.session?.activeTurnId != null ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  );
}

export function isThreadTurnDispatchBlocked(thread: OrchestrationThread): boolean {
  if (isLegacyOpencodeThread(thread)) return true;
  if (hasActiveThreadTurnOrSession(thread)) return true;
  // A requested turn stays busy until it binds or fails; its session may already say `ready`.
  if (hasPendingTurnStart(thread)) return true;
  const workflow = resolveThreadWorkflowStatus(thread);
  // A pending delegated model choice holds the first turn exactly like a pending approval.
  return (
    workflow.hasPendingApprovals ||
    workflow.hasPendingUserInput ||
    workflow.modelChoice?.status === "pending"
  );
}

/** The thread's turn waits for the user: a pending approval or user-input request. */
export function isThreadWaitingForUser(thread: OrchestrationThread): boolean {
  const workflow = resolveThreadWorkflowStatus(thread);
  return workflow.hasPendingApprovals || workflow.hasPendingUserInput;
}

/** Every queued-prompt flush and direct turn start passes this check in the decider. */
export function isThreadConfirmedIdleForDispatch(thread: OrchestrationThread): boolean {
  return !isThreadTurnDispatchBlocked(thread);
}
