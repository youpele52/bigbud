import type { ThreadId, TurnId } from "@bigbud/contracts";
import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import type { Thread } from "../../models/types";
import type { AppState } from "./main.store";
import { compareActivities, MAX_THREAD_ACTIVITIES, updateThreadState } from "./helpers.store";
import { isSummaryActivity } from "./helpers.lazy.eviction.store";
import { boundActivityPayload } from "./messageText.store";
import {
  isTranscriptHistoryActivity,
  retainUserInputHistoryActivities,
} from "./userInputHistory.store";

/** Whether the store holds any work-log activity for a turn (questions and approvals excluded). */
export function hasTurnWorkActivities(thread: Pick<Thread, "activities">, turnId: TurnId): boolean {
  return thread.activities.some(
    (activity) =>
      activity.turnId === turnId &&
      !isTranscriptHistoryActivity(activity) &&
      !isSummaryActivity(activity),
  );
}

/**
 * Merges one older turn's bounded activity page by id, in the same order and under the same
 * per-thread cap as live activity events. A thread that is not loaded ignores the page.
 */
export function mergeTurnActivities(
  state: AppState,
  threadId: ThreadId,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AppState {
  if (activities.length === 0 || state.threadHydrationById[threadId]?.status === "unloaded") {
    return state;
  }
  return updateThreadState(state, threadId, (thread) => {
    const incoming = new Map(activities.map((activity) => [activity.id, activity]));
    const merged = [
      ...thread.activities.filter((activity) => !incoming.has(activity.id)),
      ...[...incoming.values()].map(boundActivityPayload),
    ].toSorted(compareActivities);
    return {
      ...thread,
      activities: retainUserInputHistoryActivities(merged, MAX_THREAD_ACTIVITIES),
    };
  });
}
