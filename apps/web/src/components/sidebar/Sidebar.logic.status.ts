import type { SidebarThreadSummary } from "../../models/types";
import {
  isLatestTurnSettled,
  isSessionHealthChecking,
  isSessionRecovering,
  isSessionStalled,
} from "../../logic/session";
import { isThreadCompletedStatus } from "../../logic/thread/threadCompletion.logic";
import { isSessionCompacting } from "../chat/common/threadActivityIndicator";

export interface ThreadStatusPill {
  label:
    | "Connection Warning"
    | "Provider Unavailable"
    | "Failed"
    | "Idle"
    | "Working"
    | "Compacting"
    | "Getting Ready"
    | "Done"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  Failed: 7,
  "Provider Unavailable": 7,
  "Pending Approval": 6,
  "Awaiting Input": 5,
  "Connection Warning": 4,
  Working: 4,
  Compacting: 4,
  "Getting Ready": 3,
  "Plan Ready": 2,
  Done: 1,
  Idle: 0,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & { lastVisitedAt?: string | undefined };

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;
  if (isSessionHealthChecking(thread.session) && !hasActiveProviderProgress(thread)) {
    return status("Connection Warning", "text-warning", "bg-warning");
  }
  if (isSessionRecovering(thread.session)) {
    return status("Connection Warning", "text-warning", "bg-warning");
  }
  if (isSessionStalled(thread.session)) {
    return status("Provider Unavailable", "text-destructive", "bg-destructive");
  }
  if (thread.session?.orchestrationStatus === "error" || thread.latestTurn?.state === "error") {
    return status("Failed", "text-destructive", "bg-destructive");
  }
  if (thread.hasPendingApprovals) return status("Pending Approval");
  if (thread.hasPendingUserInput) return status("Awaiting Input");
  if (thread.session?.orchestrationStatus === "running" || hasActiveProviderProgress(thread)) {
    return isSessionCompacting(thread.session)
      ? status("Compacting", "text-warning", "bg-warning", true)
      : status("Working", "text-info-foreground", "bg-info-foreground", true);
  }
  if (thread.session?.orchestrationStatus === "starting") {
    return status("Getting Ready", "text-info-foreground", "bg-info-foreground", true);
  }
  if (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan
  ) {
    return status("Plan Ready");
  }
  return isThreadCompletedStatus(thread)
    ? status("Done")
    : status("Idle", "text-muted-foreground", "bg-muted-foreground");
}

/** A matching streaming turn is stronger evidence than a legacy health-only projection. */
function hasActiveProviderProgress(thread: ThreadStatusInput): boolean {
  return (
    thread.session?.activeTurnId !== undefined &&
    thread.session.activeTurnId === thread.latestTurn?.turnId &&
    thread.latestTurn.state === "running" &&
    thread.latestTurn.completedAt === null
  );
}

function status(
  label: ThreadStatusPill["label"],
  colorClass = "text-primary",
  dotClass = "bg-primary",
  pulse = false,
): ThreadStatusPill {
  return { label, colorClass, dotClass, pulse };
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  return statuses.reduce<ThreadStatusPill | null>((selected, candidate) => {
    if (candidate === null) return selected;
    return selected === null ||
      THREAD_STATUS_PRIORITY[candidate.label] > THREAD_STATUS_PRIORITY[selected.label]
      ? candidate
      : selected;
  }, null);
}
