import type { Thread } from "../../models/types";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
  hasActionableProposedPlan,
} from "../session/session.logic";
import type { TurnId } from "@bigbud/contracts/core/baseSchemas";
import { mergeNotificationTasks } from "../../notifications/taskCompletion.tasks";

/** Background Stop is control authority, not a claim that the root turn is running. */
export function hasOwnedV2DescendantWork(
  thread: Pick<Thread, "session" | "providerAgents"> | undefined,
): boolean {
  return (
    thread?.session?.provider === "opencodeV2" &&
    Boolean(
      thread.session.retainedFamily ||
      thread.providerAgents?.some(
        (task) =>
          task.kind === "providerSubagent" &&
          /^bbv2-owned:[a-f0-9]{64}$/.test(task.id) &&
          !["completed", "failed", "stopped", "cancelled"].includes(task.status),
      ),
    )
  );
}

export function countRunningBackgroundSubagents(
  thread: Pick<Thread, "session" | "providerAgents"> | undefined,
): number {
  const rootIdle = thread?.session?.activeTurnId == null;
  return (
    thread?.providerAgents?.filter(
      (task) =>
        task.kind === "providerSubagent" &&
        (task.status === "pending" || task.status === "inProgress") &&
        (task.background === true || (rootIdle && task.activityFresh === true)),
    ).length ?? 0
  );
}

export function describeThreadBackgroundWork(
  thread: Pick<Thread, "session" | "providerAgents"> | undefined,
) {
  const backgroundSubagentCount = countRunningBackgroundSubagents(thread);
  return {
    backgroundSubagentCount,
    hasBackgroundWork: hasOwnedV2DescendantWork(thread) || backgroundSubagentCount > 0,
  };
}

export function getThreadInterruptTurnId(
  thread: Pick<Thread, "session" | "providerAgents"> & {
    readonly latestTurn?: { readonly turnId?: TurnId | undefined } | null | undefined;
  },
) {
  return (
    thread.session?.activeTurnId ??
    (describeThreadBackgroundWork(thread).hasBackgroundWork ? undefined : thread.latestTurn?.turnId)
  );
}

/** Historical linked agents are not current-run work. A native ownership token is explicit proof. */
export function isCurrentRunOwnedAgent(
  thread: Thread,
  task: NonNullable<Thread["providerAgents"]>[number],
) {
  const turn = thread.latestTurn;
  return (
    turn != null &&
    task.kind === "providerSubagent" &&
    (task.turnId === turn.turnId ||
      (task.turnId == null &&
        task.createdAt >= turn.requestedAt &&
        (task.background === true ||
          task.parentTaskId != null ||
          task.parentAgentId != null ||
          /^bbv2-owned:[a-f0-9]{64}$/.test(task.id))))
  );
}

/** Versioned bounded evidence wins over replayed transcript plan data. */
export function hasCurrentRunActionablePlan(thread: Thread): boolean {
  const safety = thread.notificationSafety;
  return Boolean(
    safety?.hasActionablePlan ||
    hasActionableProposedPlan(
      safety?.selectedPlan !== undefined
        ? safety.selectedPlan
        : findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    ),
  );
}

/** Failure, removal, missing ownership evidence, and recovery are not successful settlement. */
export function hasUnsettledCurrentRunWork(
  thread: Thread,
  threadsById: ReadonlyMap<string, Thread> = new Map(),
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(thread.id)) return true;
  const session = thread.session;
  const safety = thread.notificationSafety;
  if (
    (safety && safety.turnId !== (thread.latestTurn?.turnId ?? null)) ||
    safety?.pendingStartMessageId ||
    safety?.pendingFlush ||
    session?.retainedFamily ||
    thread.error ||
    thread.recovery ||
    (session && session.orchestrationStatus !== "ready") ||
    session?.lastError ||
    session?.activeTurnId ||
    session?.status === "error" ||
    session?.status === "closed" ||
    session?.reason?.startsWith("provider.") ||
    derivePendingApprovals(thread.activities).length > 0 ||
    derivePendingUserInputs(thread.activities).length > 0 ||
    (thread.interactionMode === "plan" && hasCurrentRunActionablePlan(thread)) ||
    thread.turnStartRequest?.outcome === "pending" ||
    (thread.queuedPrompts?.length ?? 0) > 0 ||
    (safety?.queuedPromptIds.length ?? 0) > 0 ||
    (safety?.pendingRequestIds.length ?? 0) > 0 ||
    safety?.overflow ||
    (thread.pendingTurnControlOperation &&
      !["completed", "failed", "cancelled", "superseded"].includes(
        thread.pendingTurnControlOperation.state,
      )) ||
    (thread.notificationObservation?.blockedTurnId != null &&
      thread.notificationObservation.blockedTurnId === thread.latestTurn?.turnId) ||
    mergeNotificationTasks(
      thread.providerAgents ?? [],
      safety?.turnId === thread.latestTurn?.turnId ? (safety?.tasks ?? []) : [],
    ).some((task) => isCurrentRunOwnedAgent(thread, task) && task.status !== "completed")
  ) {
    return true;
  }
  const childIds = new Set<string>(
    safety?.turnId === thread.latestTurn?.turnId ? safety?.childThreadIds : [],
  );
  for (const activity of thread.activities) {
    if (
      activity.kind !== "delegation.child-linked" ||
      activity.turnId == null ||
      activity.turnId !== thread.latestTurn?.turnId
    )
      continue;
    const childId = (activity.payload as Record<string, unknown> | null)?.childThreadId;
    if (typeof childId === "string") childIds.add(childId);
  }
  visiting.add(thread.id);
  for (const id of childIds) {
    const child = threadsById.get(id);
    // A root terminal alone says nothing about that child's own descendants.
    if (
      !child ||
      !safety?.childTurns?.some(
        (link) =>
          link.threadId === id &&
          link.turnId != null &&
          link.requestMessageId != null &&
          link.turnId === child.latestTurn?.turnId &&
          link.sessionEpoch != null &&
          link.sessionEpoch === (child.session?.sessionEpoch ?? 0),
      ) ||
      child.latestTurn?.terminalOutcome !== "completed" ||
      hasUnsettledCurrentRunWork(child, threadsById, visiting)
    )
      return true;
  }
  visiting.delete(thread.id);
  return false;
}
