import type {
  GetProjectThreadSummariesResult,
  GetSelectedThreadDetailResult,
  GetStartupProjectCatalogResult,
  ProjectCatalogScope,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import type { GetSidebarThreadCatalogResult } from "@bigbud/contracts/orchestration/orchestration.catalog";

import type { AppState, ThreadHydration } from "./main.store";
import { mergeThreadDetail } from "./mappers.lazy.store";
import { sidebarMembershipFromCatalog } from "./helpers.sidebar.store";
import { applyAuthoritativeProjectThreadCounts } from "./helpers.projectThreadCount.store";
import { mergeProjectCatalog } from "./helpers.lazy.projects.store";
import { pruneProjectDependencies } from "./helpers.projectDependencies.store";
import {
  mapSequencedThreadSummary,
  mergeThreadSummary,
  mergeSidebarThreadSummary,
} from "./helpers.lazy.summaries.store";

export { mergeThreadSummary, mergeSidebarThreadSummary } from "./helpers.lazy.summaries.store";

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
  catalogs: Partial<Record<ProjectCatalogScope, GetStartupProjectCatalogResult>>,
  catalogErrors: Partial<Record<ProjectCatalogScope, string>>,
  catalogRestartProjectIds: Partial<Record<ProjectCatalogScope, ProjectId>>,
  sidebarCatalog: GetSidebarThreadCatalogResult,
  pages: ReadonlyArray<GetProjectThreadSummariesResult>,
): AppState {
  // Later map entries win, so merge snapshots in projection order, not fetch order.
  const sources = [sidebarCatalog, ...pages].toSorted(
    (a, b) => a.projectionSequence - b.projectionSequence,
  );
  const summaries = [
    ...new Map(
      sources.flatMap((source) => source.threads.map((summary) => [summary.id, summary] as const)),
    ).values(),
  ];
  const summarySequenceById = new Map(
    sources.flatMap((source) =>
      source.threads.map((summary) => [summary.id, source.projectionSequence] as const),
    ),
  );
  const previousThreads = new Map(state.threads.map((thread) => [thread.id, thread]));
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const threads = state.threads
    .map((thread) => {
      const summary = summaryById.get(thread.id);
      if (!summary) return thread;
      return mergeThreadSummary(thread, summary, summarySequenceById.get(thread.id));
    })
    .concat(
      summaries
        .filter((summary) => !previousThreads.has(summary.id))
        .map((summary) =>
          mapSequencedThreadSummary(summary, summarySequenceById.get(summary.id) ?? 0),
        ),
    );
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
  const projectThreadCountsById = {
    ...state.projectThreadCountsById,
    ...Object.fromEntries(
      (sidebarCatalog.projectThreadCounts ?? []).map((entry) => [
        entry.projectId,
        entry.threadCount,
      ]),
    ),
  };
  let projectCatalog = {
    projects: state.projects,
    projectDependencyOnlyIds: state.projectDependencyOnlyIds ?? {},
    pendingUnloadedProjectPatchById: state.pendingUnloadedProjectPatchById ?? {},
    projectCatalogSequenceById: state.projectCatalogSequenceById ?? {},
  };
  for (const scope of ["local", "remote"] as const) {
    const catalog = catalogs[scope];
    if (catalog) {
      projectCatalog = mergeProjectCatalog(
        {
          ...state,
          projects: projectCatalog.projects,
          projectDependencyOnlyIds: projectCatalog.projectDependencyOnlyIds,
          pendingUnloadedProjectPatchById: projectCatalog.pendingUnloadedProjectPatchById,
          projectCatalogSequenceById: projectCatalog.projectCatalogSequenceById,
        },
        catalog,
        projectThreadCountsById,
        false,
        scope,
      );
    }
  }
  const nextCursorByScope = { ...state.projectCatalogCursorByScope };
  const nextRemainingCountByScope = { ...state.projectCatalogRemainingCountByScope };
  const nextErrorByScope = { ...state.projectCatalogErrorByScope };
  const nextRetryHeadByScope = { ...state.projectCatalogRetryHeadByScope };
  const nextRestartProjectIdByScope = { ...state.projectCatalogRestartProjectIdByScope };
  for (const scope of ["local", "remote"] as const) {
    const catalog = catalogs[scope];
    if (catalog) {
      nextCursorByScope[scope] = catalog.nextCursor ?? null;
      nextRemainingCountByScope[scope] = catalog.remainingCount;
      nextErrorByScope[scope] = undefined;
      nextRetryHeadByScope[scope] = false;
      nextRestartProjectIdByScope[scope] = catalog.nextCursor
        ? (catalogRestartProjectIds[scope] ?? null)
        : null;
    } else {
      nextCursorByScope[scope] = null;
      nextRemainingCountByScope[scope] = null;
      nextErrorByScope[scope] = catalogErrors[scope] ?? "Unable to load projects.";
      nextRetryHeadByScope[scope] = true;
      nextRestartProjectIdByScope[scope] = null;
    }
  }
  return {
    ...state,
    projects: projectCatalog.projects,
    projectDependencyOnlyIds: projectCatalog.projectDependencyOnlyIds,
    projectCatalogCursorByScope: nextCursorByScope,
    projectCatalogRemainingCountByScope: nextRemainingCountByScope,
    projectCatalogGenerationByScope: {
      local: state.projectCatalogGenerationByScope.local + 1,
      remote: state.projectCatalogGenerationByScope.remote + 1,
    },
    projectCatalogLoadingByScope: { local: false, remote: false },
    projectCatalogErrorByScope: nextErrorByScope,
    projectCatalogRetryHeadByScope: nextRetryHeadByScope,
    projectCatalogRestartProjectIdByScope: nextRestartProjectIdByScope,
    pendingUnloadedProjectPatchById: projectCatalog.pendingUnloadedProjectPatchById,
    projectCatalogSequenceById: projectCatalog.projectCatalogSequenceById,
    projectThreadCountsById,
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    threadSummaryCursorByProjectId,
    threadHydrationById,
    ...sidebarMembershipFromCatalog({
      recentThreadIds: sidebarCatalog.recentThreadIds,
      pinnedThreadIds: sidebarCatalog.pinnedThreadIds,
      localRecentThreadIds: state.sidebarRecentThreadIds,
      localPinnedThreadIds: state.sidebarPinnedThreadIds,
      localThreads: state.threads,
      catalogAvailableIds: availableThreadIds,
    }),
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
      return summary
        ? mergeThreadSummary(thread, summary, sidebarCatalog.projectionSequence)
        : thread;
    })
    .concat(
      summaries
        .filter((summary) => !previousThreads.has(summary.id))
        .map((summary) => mapSequencedThreadSummary(summary, sidebarCatalog.projectionSequence)),
    );
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
    projectThreadCountsById: {
      ...state.projectThreadCountsById,
      ...Object.fromEntries(
        (sidebarCatalog.projectThreadCounts ?? []).map((entry) => [
          entry.projectId,
          entry.threadCount,
        ]),
      ),
    },
    threads,
    sidebarThreadsById,
    threadHydrationById,
    ...sidebarMembershipFromCatalog({
      recentThreadIds: sidebarCatalog.recentThreadIds,
      pinnedThreadIds: sidebarCatalog.pinnedThreadIds,
      localRecentThreadIds: state.sidebarRecentThreadIds,
      localPinnedThreadIds: state.sidebarPinnedThreadIds,
      localThreads: state.threads,
      catalogAvailableIds: availableThreadIds,
    }),
  };
}

export function appendProjectCatalogPage(
  state: AppState,
  scope: ProjectCatalogScope,
  page: GetStartupProjectCatalogResult,
  generation?: number,
  loading = false,
): AppState {
  if (generation !== undefined && state.projectCatalogGenerationByScope[scope] !== generation) {
    return state;
  }

  const projectCatalog = mergeProjectCatalog(state, page, state.projectThreadCountsById, true);

  return {
    ...state,
    projects: projectCatalog.projects,
    projectDependencyOnlyIds: projectCatalog.projectDependencyOnlyIds,
    projectCatalogCursorByScope: {
      ...state.projectCatalogCursorByScope,
      [scope]: page.nextCursor ?? null,
    },
    projectCatalogRemainingCountByScope: {
      ...state.projectCatalogRemainingCountByScope,
      [scope]: page.remainingCount,
    },
    projectCatalogLoadingByScope: { ...state.projectCatalogLoadingByScope, [scope]: loading },
    projectCatalogErrorByScope: { ...state.projectCatalogErrorByScope, [scope]: undefined },
    projectCatalogRetryHeadByScope: { ...state.projectCatalogRetryHeadByScope, [scope]: false },
    projectCatalogRestartProjectIdByScope: {
      ...state.projectCatalogRestartProjectIdByScope,
      [scope]: null,
    },
    pendingUnloadedProjectPatchById: projectCatalog.pendingUnloadedProjectPatchById,
    projectCatalogSequenceById: projectCatalog.projectCatalogSequenceById,
  };
}

export function mergeProjectCatalogPage(
  state: AppState,
  page: GetStartupProjectCatalogResult,
): AppState {
  const projectCatalog = mergeProjectCatalog(
    state,
    page,
    state.projectThreadCountsById,
    true,
    undefined,
    true,
  );
  return pruneProjectDependencies({ ...state, ...projectCatalog });
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
        return summary ? mergeThreadSummary(thread, summary, page.projectionSequence) : thread;
      })
      .concat(
        page.threads
          .filter((summary) => !state.threads.some((thread) => thread.id === summary.id))
          .map((summary) => mapSequencedThreadSummary(summary, page.projectionSequence)),
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
