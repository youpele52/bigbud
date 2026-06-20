import { isLatestTurnSettled } from "../session";
import type { SidebarThreadSummary } from "../../models/types";

type ThreadCompletionStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
};

export function hasUnseenCompletion(thread: ThreadCompletionStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function isThreadCompletedStatus(thread: ThreadCompletionStatusInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return false;
  }

  if (thread.session?.status === "running" || thread.session?.status === "connecting") {
    return false;
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return false;
  }

  return hasUnseenCompletion(thread);
}
