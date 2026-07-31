import type {
  GetProjectThreadSummariesResult,
  GetSelectedThreadDetailResult,
  GetStartupProjectCatalogResult,
  ThreadId,
} from "@bigbud/contracts";

import type { AppState, ThreadHydration } from "./main.store";
import {
  mapProjectSummary,
  mapSidebarThreadSummary,
  mapThreadSummary,
  mergeThreadDetail,
} from "./mappers.lazy.store";

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
  pages: ReadonlyArray<GetProjectThreadSummariesResult>,
): AppState {
  const summaries = pages.flatMap((page) => page.threads);
  const previousThreads = new Map(state.threads.map((thread) => [thread.id, thread]));
  const threads = summaries.map(
    (summary) => previousThreads.get(summary.id) ?? mapThreadSummary(summary),
  );
  const sidebarThreadsById = Object.fromEntries(
    summaries.map((summary) => [summary.id, mapSidebarThreadSummary(summary)]),
  );
  const threadIdsByProjectId = Object.fromEntries(
    pages.map((page) => [page.projectId, page.threads.map((thread) => thread.id)]),
  );
  const threadSummaryCursorByProjectId = Object.fromEntries(
    pages.map((page) => [page.projectId, page.nextCursor ?? null]),
  );
  const threadHydrationById: AppState["threadHydrationById"] = Object.fromEntries(
    summaries.map((summary) => [
      summary.id,
      state.threadHydrationById[summary.id] ?? ({ status: "unloaded" } as const),
    ]),
  );
  return {
    ...state,
    projects: catalog.projects.map(mapProjectSummary),
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    threadSummaryCursorByProjectId,
    threadHydrationById,
    bootstrapComplete: true,
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
        return summary
          ? { ...thread, ...mapThreadSummary(summary), messages: thread.messages }
          : thread;
      })
      .concat(
        page.threads
          .filter((summary) => !state.threads.some((thread) => thread.id === summary.id))
          .map(mapThreadSummary),
      ),
    sidebarThreadsById: {
      ...state.sidebarThreadsById,
      ...Object.fromEntries(
        page.threads.map((summary) => [summary.id, mapSidebarThreadSummary(summary)]),
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
