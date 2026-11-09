import type { ThreadId } from "@bigbud/contracts";
import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import type { Thread } from "../../models/types";
import type { AppState, ThreadHydration } from "./main.store";
import { isUserInputHistoryActivity } from "./userInputHistory.store";

/** Threads that keep their full detail; the rest fall back to their summary and re-hydrate. */
export const MAX_HYDRATED_THREADS = 8;

/** Activities the sidebar summary derives pending approvals and questions from. */
export function isSummaryActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "approval.requested" ||
    activity.kind === "approval.resolved" ||
    activity.kind === "provider.approval.respond.failed" ||
    isUserInputHistoryActivity(activity)
  );
}

/** A thread known only from its summary: live events update the summary, never the transcript. */
export function isSummaryOnlyThread(state: AppState, threadId: ThreadId): boolean {
  return state.threadHydrationById[threadId]?.status === "unloaded";
}

/** Drops the transcript and keeps what the summary needs (pending requests, the latest plan). */
export function unloadThreadDetail(thread: Thread): Thread {
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  const latestPlan = thread.proposedPlans.findLast(
    (plan) => latestTurnId === null || plan.turnId === latestTurnId,
  );
  return {
    ...thread,
    messages: [],
    activities: thread.activities.filter(isSummaryActivity),
    proposedPlans: latestPlan ? [latestPlan] : [],
    turnDiffSummaries: [],
  };
}

function holdsDetail(thread: Thread, hydration: ThreadHydration | undefined): boolean {
  if (thread.purpose === "side-chat") return false;
  switch (hydration?.status) {
    case "loaded":
    case "complete":
      return true;
    case "failed":
      return hydration.retry.kind === "older";
    case undefined:
      // Created during this session and filled by live events only.
      return thread.messages.length > 0;
    default:
      return false;
  }
}

function unloadThreads(state: AppState, keep: (threadId: ThreadId) => boolean): AppState {
  const unloadedIds = new Set<ThreadId>();
  const threads = state.threads.map((thread) => {
    if (keep(thread.id) || !holdsDetail(thread, state.threadHydrationById[thread.id])) {
      return thread;
    }
    unloadedIds.add(thread.id);
    return unloadThreadDetail(thread);
  });
  if (unloadedIds.size === 0) return state;
  const threadHydrationById = { ...state.threadHydrationById };
  for (const threadId of unloadedIds) {
    threadHydrationById[threadId] = { status: "unloaded" };
  }
  return { ...state, threads, threadHydrationById };
}

/**
 * Records a thread view and keeps full detail only for the `MAX_HYDRATED_THREADS` most recently
 * viewed threads. Threads with a request in flight are left alone; they are evicted on a later view.
 */
export function markThreadViewed(state: AppState, threadId: ThreadId): AppState {
  const previous = state.recentlyViewedThreadIds ?? [];
  if (previous[0] === threadId) return state;
  const recentlyViewedThreadIds = [threadId, ...previous.filter((id) => id !== threadId)].slice(
    0,
    MAX_HYDRATED_THREADS,
  );
  const retained = new Set(recentlyViewedThreadIds);
  return unloadThreads({ ...state, recentlyViewedThreadIds }, (id) => retained.has(id));
}

/** Revoked epoch tokens cannot finish their loads; drop stale detail and allow a fresh request. */
export function invalidateInFlightThreadHydrations(state: AppState): AppState {
  const threadHydrationById = { ...state.threadHydrationById };
  const invalidated = new Set<string>();
  for (const [id, hydration] of Object.entries(threadHydrationById)) {
    if (hydration.status === "loading" || hydration.status === "loadingOlder") {
      invalidated.add(id);
      threadHydrationById[id] = { status: "unloaded" };
    }
  }
  if (invalidated.size === 0) return state;
  return {
    ...state,
    threadHydrationById,
    threads: state.threads.map((thread) =>
      invalidated.has(thread.id) ? unloadThreadDetail(thread) : thread,
    ),
  };
}

/** After a baseline reset every hydrated thread but the selected one is stale: re-hydrate on open. */
export function unloadHydratedThreads(state: AppState, keepThreadId: ThreadId | null): AppState {
  return unloadThreads(state, (id) => id === keepThreadId);
}
