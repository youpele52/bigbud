import type { GetOrganizationThreadSummariesResult } from "@bigbud/contracts/orchestration/orchestration.catalog.organization.ts";
import type { OrchestrationEvent } from "@bigbud/contracts";

import type { AppState } from "./main.store";
import { mapThreadSummary } from "./mappers.lazy.store";
import { mergeSidebarThreadSummary, mergeThreadSummary } from "./helpers.lazy.store";
import { updateThreadState } from "./helpers.store";
import { newerOrganization } from "./helpers.organization.logic.store";

/**
 * Adds one Ìtútù state page to the known threads. Like pinned threads, page threads get summaries
 * without project membership, so project lists and their cursors are unaffected.
 */
export function appendOrganizationPage(
  state: AppState,
  page: GetOrganizationThreadSummariesResult,
): AppState {
  if (page.threads.length === 0) return state;
  const summaries = new Map(page.threads.map((summary) => [summary.id, summary]));
  const known = new Set(state.threads.map((thread) => thread.id));
  const threads = state.threads
    .map((thread) => {
      const summary = summaries.get(thread.id);
      return summary ? mergeThreadSummary(thread, summary) : thread;
    })
    .concat(page.threads.filter((summary) => !known.has(summary.id)).map(mapThreadSummary));
  return {
    ...state,
    threads,
    sidebarThreadsById: {
      ...state.sidebarThreadsById,
      ...Object.fromEntries(
        page.threads.map((summary) => [
          summary.id,
          mergeSidebarThreadSummary(state.sidebarThreadsById[summary.id], summary),
        ]),
      ),
    },
    threadHydrationById: {
      ...state.threadHydrationById,
      ...Object.fromEntries(
        page.threads.map((summary) => [
          summary.id,
          state.threadHydrationById[summary.id] ?? ({ status: "unloaded" } as const),
        ]),
      ),
    },
  };
}

/** Applies `thread.organization-updated` to a known thread and its sidebar summary. */
export function applyThreadOrganizationEvent(
  state: AppState,
  event: Extract<OrchestrationEvent, { type: "thread.organization-updated" }>,
): AppState {
  const { threadId, organization } = event.payload;
  return updateThreadState(state, threadId, (thread) => {
    const next = newerOrganization(thread.organization, organization);
    return next === thread.organization ? thread : { ...thread, organization: next };
  });
}
