import type { AppState } from "./main.store";
import { mapSidebarThreadSummary, mapThreadSummary } from "./mappers.lazy.store";
import { newerOrganization } from "./helpers.organization.logic.store";

export function mergeThreadSummary(
  thread: AppState["threads"][number],
  summary: Parameters<typeof mapThreadSummary>[0],
): AppState["threads"][number] {
  const mapped = mapThreadSummary(summary);
  return {
    ...thread,
    ...mapped,
    organization: newerOrganization(thread.organization, mapped.organization),
    session: thread.session ?? mapped.session,
    latestTurn: thread.latestTurn ?? mapped.latestTurn,
    error: thread.error ?? mapped.error,
    elevatorSummaryMessageCount:
      thread.elevatorSummaryMessageCount ?? mapped.elevatorSummaryMessageCount ?? 0,
    archivedAt: thread.archivedAt,
    ...(thread.deletingAt !== undefined ? { deletingAt: thread.deletingAt } : {}),
    messages: thread.messages,
    activities: thread.activities,
    proposedPlans: thread.proposedPlans,
    turnDiffSummaries: thread.turnDiffSummaries,
    ...(thread.pendingSourceProposedPlan !== undefined
      ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
      : {}),
  };
}

export function mergeSidebarThreadSummary(
  previous: AppState["sidebarThreadsById"][string] | undefined,
  summary: Parameters<typeof mapSidebarThreadSummary>[0],
): AppState["sidebarThreadsById"][string] {
  const mapped = mapSidebarThreadSummary(summary);
  if (!previous) return mapped;
  return {
    ...mapped,
    organization: newerOrganization(previous.organization, mapped.organization),
    session: previous.session ?? mapped.session,
    latestTurn: previous.latestTurn ?? mapped.latestTurn,
    elevatorSummaryMessageCount:
      previous.elevatorSummaryMessageCount ?? mapped.elevatorSummaryMessageCount ?? 0,
    archivedAt: previous.archivedAt,
    ...(previous.providerAgents !== undefined ? { providerAgents: previous.providerAgents } : {}),
    ...(previous.deletingAt !== undefined ? { deletingAt: previous.deletingAt } : {}),
  };
}
