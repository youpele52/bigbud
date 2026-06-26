import type {
  OrchestrationMessage,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@bigbud/contracts";

/** Matches mobile list preview needs; full history loads via getMobileThread. */
export const MOBILE_SNAPSHOT_MAX_MESSAGES_PER_THREAD = 4;

const MOBILE_SNAPSHOT_ESSENTIAL_ACTIVITY_PREFIXES = ["approval.", "user-input."] as const;

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    left.sequence !== right.sequence
  ) {
    return left.sequence - right.sequence;
  }
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }
  return left.id.localeCompare(right.id);
}

function isEssentialMobileActivity(activity: OrchestrationThreadActivity): boolean {
  return MOBILE_SNAPSHOT_ESSENTIAL_ACTIVITY_PREFIXES.some((prefix) =>
    activity.kind.startsWith(prefix),
  );
}

function trimMessagesForMobile(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  if (messages.length <= MOBILE_SNAPSHOT_MAX_MESSAGES_PER_THREAD) {
    return messages;
  }
  return messages.slice(-MOBILE_SNAPSHOT_MAX_MESSAGES_PER_THREAD);
}

function trimActivitiesForMobile(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | null | undefined,
): ReadonlyArray<OrchestrationThreadActivity> {
  const retained = new Map<string, OrchestrationThreadActivity>();

  for (const activity of activities) {
    if (isEssentialMobileActivity(activity)) {
      retained.set(activity.id, activity);
      continue;
    }
    if (latestTurnId !== null && latestTurnId !== undefined && activity.turnId === latestTurnId) {
      retained.set(activity.id, activity);
    }
  }

  return [...retained.values()].toSorted(compareActivitiesByOrder);
}

function trimThreadForMobile(thread: OrchestrationThread): OrchestrationThread {
  const latestTurnId = thread.latestTurn?.turnId ?? null;

  return {
    ...thread,
    messages: trimMessagesForMobile(thread.messages),
    activities: trimActivitiesForMobile(thread.activities, latestTurnId),
    checkpoints: [],
    proposedPlans:
      latestTurnId === null
        ? []
        : thread.proposedPlans.filter((plan) => plan.turnId === latestTurnId),
    watchingThreads: [],
  };
}

function isActiveMobileThread(thread: OrchestrationThread): boolean {
  return thread.archivedAt === null && thread.deletedAt === null;
}

export function trimOrchestrationSnapshotForMobile(
  snapshot: OrchestrationReadModel,
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.filter(isActiveMobileThread).map(trimThreadForMobile),
  };
}
