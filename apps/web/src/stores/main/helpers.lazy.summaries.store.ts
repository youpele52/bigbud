import type { AppState } from "./main.store";
import { mapSidebarThreadSummary, mapThreadSummary } from "./mappers.lazy.store";
import { newerOrganization } from "./helpers.organization.logic.store";
import { mergeNotificationTasks } from "../../notifications/taskCompletion.tasks";
import { capProviderAgents } from "./events.store.providerAgents";
import { invalidateNotificationEpoch } from "../../notifications/taskCompletion.observations";

export function mapSequencedThreadSummary(
  summary: Parameters<typeof mapThreadSummary>[0],
  projectionSequence: number,
): AppState["threads"][number] {
  const thread = mapThreadSummary(summary);
  thread.notificationSafetySequence = projectionSequence;
  thread.notificationObservation = { messages: [], baselineSequence: projectionSequence };
  return thread;
}

export function mergeThreadSummary(
  thread: AppState["threads"][number],
  summary: Parameters<typeof mapThreadSummary>[0],
  projectionSequence?: number,
): AppState["threads"][number] {
  if (
    projectionSequence !== undefined &&
    projectionSequence < (thread.notificationSafetySequence ?? 0)
  )
    return thread;
  const mapped = mapThreadSummary(summary);
  const authoritative = projectionSequence !== undefined;

  return invalidateNotificationEpoch(thread, {
    ...thread,
    ...mapped,
    organization: newerOrganization(thread.organization, mapped.organization),
    ...(projectionSequence !== undefined ? { notificationSafetySequence: projectionSequence } : {}),
    session: authoritative ? mapped.session : (thread.session ?? mapped.session),
    latestTurn: authoritative ? mapped.latestTurn : (thread.latestTurn ?? mapped.latestTurn),
    error: thread.error ?? mapped.error,
    providerAgents: capProviderAgents(
      mergeNotificationTasks(thread.providerAgents ?? [], mapped.providerAgents ?? []),
    ),
    recovery: authoritative
      ? (mapped.recovery ?? null)
      : (thread.recovery ?? mapped.recovery ?? null),
    pendingTurnControlOperation: authoritative
      ? (mapped.pendingTurnControlOperation ?? null)
      : (thread.pendingTurnControlOperation ?? mapped.pendingTurnControlOperation ?? null),
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
  });
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
