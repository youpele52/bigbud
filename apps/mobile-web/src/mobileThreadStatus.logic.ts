import type { OrchestrationSession, OrchestrationThread, ProviderKind } from "@bigbud/contracts";

import { isSessionCompacting } from "~/components/chat/common/threadActivityIndicator";
import { resolveThreadStatusPill } from "~/components/sidebar/Sidebar.logic";
import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
} from "~/logic/session/session.timeline.logic";
import type { ThreadSession } from "~/models/types/app.types";

import { derivePendingApprovals, derivePendingUserInputs } from "./mobileModels";

function adaptSessionForStatus(session: OrchestrationSession | null): ThreadSession | null {
  if (!session) {
    return null;
  }

  const status: ThreadSession["status"] =
    session.status === "running"
      ? "running"
      : session.status === "starting"
        ? "connecting"
        : session.status === "error"
          ? "error"
          : "ready";

  return {
    provider: "codex" as ProviderKind,
    status,
    orchestrationStatus: session.status,
    reason: session.reason ?? null,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
  };
}

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
  const isThreadCompleted = threadStatus?.label === "Completed";

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
