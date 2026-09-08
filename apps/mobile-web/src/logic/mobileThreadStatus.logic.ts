import type { OrchestrationThread } from "@bigbud/contracts";

import { isSessionCompacting } from "~/components/chat/common/threadActivityIndicator";
import { resolveThreadStatusPill } from "~/components/sidebar/Sidebar.logic";
import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
} from "~/logic/session/session.timeline.logic";
import { mapSession } from "~/stores/main/mappers.store";

import { derivePendingApprovals, derivePendingUserInputs } from "../lib/mobileModels";

const adaptSessionForStatus = (session: OrchestrationThread["session"]) =>
  session === null ? null : mapSession(session);

export function buildMobileThreadStatusInput(
  thread: OrchestrationThread,
  lastVisitedAt?: string | undefined,
) {
  return {
    hasActionableProposedPlan: hasActionableProposedPlan(
      findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    ),
    hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
    interactionMode: thread.interactionMode,
    latestTurn: thread.latestTurn,
    session: adaptSessionForStatus(thread.session),
    ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
  };
}

export function resolveMobileProviderIconClassName(
  thread: OrchestrationThread,
  lastVisitedAt?: string | undefined,
): string {
  const statusInput = buildMobileThreadStatusInput(thread, lastVisitedAt);
  const threadStatus = resolveThreadStatusPill({ thread: statusInput });
  const isThreadRunning = thread.session?.status === "running";
  const isThreadCompacting = thread.session
    ? isSessionCompacting(adaptSessionForStatus(thread.session))
    : false;
  const isThreadCompleted = threadStatus?.label === "Done";

  if (thread.session?.status === "error") {
    return "text-destructive";
  }
  if (isThreadCompacting) {
    return "text-warning";
  }
  if (isThreadRunning) {
    return "text-info-foreground";
  }
  if (isThreadCompleted) {
    return "text-success";
  }
  return "text-muted-foreground";
}
