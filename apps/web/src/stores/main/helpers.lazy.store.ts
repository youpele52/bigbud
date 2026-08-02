import type {
  GetProjectThreadSummariesResult,
  GetSelectedThreadDetailResult,
  GetStartupProjectCatalogResult,
  ThreadId,
} from "@bigbud/contracts";
import type { GetSidebarThreadCatalogResult } from "@bigbud/contracts/orchestration/orchestration.catalog";
import { FAVORITE_THREAD_LIMIT } from "@bigbud/contracts/constants/settings.constant";
import { SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS } from "@bigbud/contracts/orchestration/orchestration.catalog";

import type { AppState, ThreadHydration } from "./main.store";
import {
  mapProjectSummary,
  mapSidebarThreadSummary,
  mapThreadSummary,
  mergeThreadDetail,
} from "./mappers.lazy.store";
import { normalizeSidebarThreadIds } from "./helpers.sidebar.store";
import { applyAuthoritativeProjectThreadCounts } from "./helpers.projectThreadCount.store";

function mergeThreadSummary(
  thread: AppState["threads"][number],
  summary: Parameters<typeof mapThreadSummary>[0],
): AppState["threads"][number] {
  const mapped = mapThreadSummary(summary);
  return {
    ...thread,
    ...mapped,
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

function mergeSidebarThreadSummary(
  previous: AppState["sidebarThreadsById"][string] | undefined,
  summary: Parameters<typeof mapSidebarThreadSummary>[0],
): AppState["sidebarThreadsById"][string] {
  const mapped = mapSidebarThreadSummary(summary);
  if (!previous) return mapped;
  return {
    ...mapped,
    session: previous.session ?? mapped.session,
    latestTurn: previous.latestTurn ?? mapped.latestTurn,
    elevatorSummaryMessageCount:
      previous.elevatorSummaryMessageCount ?? mapped.elevatorSummaryMessageCount ?? 0,
    archivedAt: previous.archivedAt,
    ...(previous.deletingAt !== undefined ? { deletingAt: previous.deletingAt } : {}),
  };
}

export function setThreadHydration(
  state: AppState,
  threadId: ThreadId,
  hydration: ThreadHydration,
): AppState {
  return {
    ...state,
    threadHydrationById: { ...state.threadHydrationById, [threadId]: hydration },
  };
}

export function syncBoundedCatalog(
  state: AppState,
  catalog: GetStartupProjectCatalogResult,
  sidebarCatalog: GetSidebarThreadCatalogResult,
  pages: ReadonlyArray<GetProjectThreadSummariesResult>,
): AppState {
  const summaries = [
    ...new Map(
      [...sidebarCatalog.threads, ...pages.flatMap((page) => page.threads)].map((summary) => [
        summary.id,
        summary,
      ]),
    ).values(),
  ];
  const previousThreads = new Map(state.threads.map((thread) => [thread.id, thread]));
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const threads = state.threads
    .map((thread) => {
      const summary = summaryById.get(thread.id);
      if (!summary) return thread;
      return mergeThreadSummary(thread, summary);
    })
    .concat(summaries.filter((summary) => !previousThreads.has(summary.id)).map(mapThreadSummary));
  const sidebarThreadsById = {
    ...state.sidebarThreadsById,
    ...Object.fromEntries(
      summaries.map((summary) => [
        summary.id,
        mergeSidebarThreadSummary(state.sidebarThreadsById[summary.id], summary),
      ]),
    ),
  };
  const threadIdsByProjectId = {
    ...state.threadIdsByProjectId,
    ...Object.fromEntries(
      pages.map((page) => [page.projectId, page.threads.map((thread) => thread.id)]),
    ),
  };
  const threadSummaryCursorByProjectId = {
    ...state.threadSummaryCursorByProjectId,
    ...Object.fromEntries(pages.map((page) => [page.projectId, page.nextCursor ?? null])),
  };
  const threadHydrationById: AppState["threadHydrationById"] = {
    ...state.threadHydrationById,
    ...Object.fromEntries(
      summaries.map((summary) => [
        summary.id,
        state.threadHydrationById[summary.id] ?? ({ status: "unloaded" } as const),
      ]),
    ),
  };
  const availableThreadIds = new Set(summaries.map((summary) => summary.id));
  return {
    ...state,
    projects: catalog.projects.map(mapProjectSummary),
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    threadSummaryCursorByProjectId,
    threadHydrationById,
    sidebarRecentThreadIds: normalizeSidebarThreadIds(
      sidebarCatalog.recentThreadIds,
      availableThreadIds,
      SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS,
    ),
    sidebarPinnedThreadIds: normalizeSidebarThreadIds(
      sidebarCatalog.pinnedThreadIds,
      availableThreadIds,
      FAVORITE_THREAD_LIMIT,
    ),
    bootstrapComplete: true,
  };
}

export function syncSidebarCatalog(
  state: AppState,
  sidebarCatalog: GetSidebarThreadCatalogResult,
): AppState {
  const summaries = sidebarCatalog.threads;
  const previousThreads = new Map(state.threads.map((thread) => [thread.id, thread]));
  const threads = state.threads
    .map((thread) => {
      const summary = summaries.find((candidate) => candidate.id === thread.id);
      return summary ? mergeThreadSummary(thread, summary) : thread;
    })
    .concat(summaries.filter((summary) => !previousThreads.has(summary.id)).map(mapThreadSummary));
  const sidebarThreadsById = {
    ...state.sidebarThreadsById,
    ...Object.fromEntries(
      summaries.map((summary) => [
        summary.id,
        mergeSidebarThreadSummary(state.sidebarThreadsById[summary.id], summary),
      ]),
    ),
  };
  const threadHydrationById: AppState["threadHydrationById"] = {
    ...state.threadHydrationById,
    ...Object.fromEntries(
      summaries.map((summary) => [
        summary.id,
        state.threadHydrationById[summary.id] ?? ({ status: "unloaded" } as const),
      ]),
    ),
  };
  const availableThreadIds = new Set(summaries.map((summary) => summary.id));
  return {
    ...state,
    projects: applyAuthoritativeProjectThreadCounts(
      state.projects,
      sidebarCatalog.projectThreadCounts,
    ),
    threads,
    sidebarThreadsById,
    threadHydrationById,
    sidebarRecentThreadIds: normalizeSidebarThreadIds(
      sidebarCatalog.recentThreadIds,
      availableThreadIds,
      SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS,
    ),
    sidebarPinnedThreadIds: normalizeSidebarThreadIds(
      sidebarCatalog.pinnedThreadIds,
      availableThreadIds,
      FAVORITE_THREAD_LIMIT,
    ),
  };
}

export function appendProjectThreadSummaries(
  state: AppState,
  page: GetProjectThreadSummariesResult,
): AppState {
  const existingIds = state.threadIdsByProjectId[page.projectId] ?? [];
  const summaryById = new Map(page.threads.map((summary) => [summary.id, summary]));
  const appendedIds = page.threads
    .map((summary) => summary.id)
    .filter((threadId) => !existingIds.includes(threadId));
  const nextIds = [...existingIds, ...appendedIds];

  return {
    ...state,
    threads: state.threads
      .map((thread) => {
        const summary = summaryById.get(thread.id);
        return summary ? mergeThreadSummary(thread, summary) : thread;
      })
      .concat(
        page.threads
          .filter((summary) => !state.threads.some((thread) => thread.id === summary.id))
          .map(mapThreadSummary),
      ),
    sidebarThreadsById: {
      ...state.sidebarThreadsById,
      ...Object.fromEntries(
        page.threads.map((summary) => [
          summary.id,
          mergeSidebarThreadSummary(state.sidebarThreadsById[summary.id], summary),
        ]),
      ),
    },
    threadIdsByProjectId: { ...state.threadIdsByProjectId, [page.projectId]: nextIds },
    threadSummaryCursorByProjectId: {
      ...state.threadSummaryCursorByProjectId,
      [page.projectId]: page.nextCursor ?? null,
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

export function syncSelectedThreadDetail(
  state: AppState,
  detail: GetSelectedThreadDetailResult,
  loadingOlder: boolean,
): AppState {
  const thread = state.threads.find((entry) => entry.id === detail.threadId);
  if (!thread) {
    return setThreadHydration(state, detail.threadId, {
      status: "failed",
      error: "Selected thread summary was not loaded.",
      retry: { kind: "initial" },
    });
  }
  return {
    ...state,
    threads: state.threads.map((entry) =>
      entry.id === detail.threadId ? mergeThreadDetail(entry, detail, loadingOlder) : entry,
    ),
    threadHydrationById: {
      ...state.threadHydrationById,
      [detail.threadId]: detail.messageWindow.hasOlder
        ? { status: "loaded", nextCursor: detail.messageWindow.nextCursor }
        : { status: "complete" },
    },
  };
}
