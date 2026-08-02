import {
  PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT,
  STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT,
  STARTUP_PROJECT_CATALOG_MAX_LIMIT,
  ThreadId,
  type GetProjectThreadSummariesResult,
  type GetStartupProjectCatalogResult,
} from "@bigbud/contracts";
import type { GetSidebarThreadCatalogResult } from "@bigbud/contracts/orchestration/orchestration.catalog";

import type { readNativeApi } from "../rpc/nativeApi";
import { useStore } from "../stores/main";
import {
  applyReleasedThreadHydrationEvents,
  threadHydrationEventBuffer,
} from "../logic/orchestration/thread-hydration-events.logic";

type Api = NonNullable<ReturnType<typeof readNativeApi>>;

export function resolveSelectedThreadIdFromPath(
  pathname: string,
  fallback: ThreadId | null,
): ThreadId | null {
  if (
    !/^\/[^/]+$/.test(pathname) ||
    pathname === "/automations" ||
    pathname === "/usage" ||
    pathname === "/settings"
  ) {
    return fallback;
  }
  return ThreadId.makeUnsafe(decodeURIComponent(pathname.slice(1)));
}

export async function runBoundedBootstrap(input: {
  api: Api;
  selectedThreadId: ThreadId | null;
  disposed: () => boolean;
}): Promise<number> {
  const sequences: number[] = [];
  let selectedDetail = null;
  let selectedDetailError: unknown = null;
  const hydrationToken =
    input.selectedThreadId === null
      ? null
      : threadHydrationEventBuffer.begin(input.selectedThreadId);

  if (input.selectedThreadId !== null) {
    useStore.getState().setThreadHydration(input.selectedThreadId, { status: "loading" });
    try {
      selectedDetail = await input.api.orchestration.getSelectedThreadDetail({
        threadId: input.selectedThreadId,
      });
      sequences.push(selectedDetail.projectionSequence);
    } catch (error) {
      selectedDetailError = error;
    }
  }

  let catalog: GetStartupProjectCatalogResult;
  let sidebarCatalog: GetSidebarThreadCatalogResult;
  const pages: GetProjectThreadSummariesResult[] = [];
  try {
    sidebarCatalog = await input.api.orchestration.getSidebarThreadCatalog();
    sequences.push(sidebarCatalog.projectionSequence);
    const firstCatalogPage = await input.api.orchestration.getStartupProjectCatalog({
      limit: STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT,
      ...(selectedDetail ? { priorityProjectId: selectedDetail.projectId } : {}),
    });
    sequences.push(firstCatalogPage.projectionSequence);

    const projectsById = new Map(firstCatalogPage.projects.map((project) => [project.id, project]));
    let cursor = firstCatalogPage.nextCursor;
    while (cursor !== undefined) {
      const page = await input.api.orchestration.getStartupProjectCatalog({
        limit: STARTUP_PROJECT_CATALOG_MAX_LIMIT,
        cursor,
      });
      sequences.push(page.projectionSequence);
      for (const project of page.projects) {
        projectsById.set(project.id, project);
      }
      cursor = page.nextCursor;
    }
    catalog = {
      projectionSequence: firstCatalogPage.projectionSequence,
      projects: [...projectsById.values()],
    };

    for (const project of firstCatalogPage.projects) {
      const page = await input.api.orchestration.getProjectThreadSummaries({
        projectId: project.id,
        limit: PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT,
        ...(selectedDetail?.projectId === project.id && input.selectedThreadId
          ? { priorityThreadId: input.selectedThreadId }
          : {}),
      });
      pages.push(page);
      sequences.push(page.projectionSequence);
    }
  } catch (error) {
    if (input.selectedThreadId !== null && hydrationToken !== null) {
      const events = threadHydrationEventBuffer.fail(input.selectedThreadId, hydrationToken);
      if (!input.disposed() && events !== null) {
        useStore.getState().setThreadHydration(input.selectedThreadId, {
          status: "failed",
          error: error instanceof Error ? error.message : "Unable to load thread catalog.",
          retry: { kind: "initial" },
        });
        applyReleasedThreadHydrationEvents(events);
      }
    }
    throw error;
  }

  if (!input.disposed()) {
    const store = useStore.getState();
    store.syncBoundedCatalog(catalog, sidebarCatalog, pages);
    if (selectedDetail !== null && hydrationToken !== null) {
      const events = threadHydrationEventBuffer.finish(
        selectedDetail.threadId,
        hydrationToken,
        selectedDetail.projectionSequence,
      );
      if (events !== null) {
        store.syncSelectedThreadDetail(selectedDetail, false);
        applyReleasedThreadHydrationEvents(events);
      }
    } else if (input.selectedThreadId !== null && hydrationToken !== null) {
      const events = threadHydrationEventBuffer.fail(input.selectedThreadId, hydrationToken);
      if (events !== null) {
        store.setThreadHydration(input.selectedThreadId, {
          status: "failed",
          error:
            selectedDetailError instanceof Error
              ? selectedDetailError.message
              : "Unable to load the selected thread.",
          retry: { kind: "initial" },
        });
        applyReleasedThreadHydrationEvents(events);
      }
    }
  }

  return Math.min(...sequences);
}

export async function loadOlderThreadMessages(input: {
  api: Api;
  threadId: ThreadId;
}): Promise<void> {
  const hydration = useStore.getState().threadHydrationById[input.threadId];
  const nextCursor =
    hydration?.status === "loaded"
      ? hydration.nextCursor
      : hydration?.status === "failed" && hydration.retry.kind === "older"
        ? hydration.retry.nextCursor
        : null;
  if (nextCursor === null) {
    return;
  }
  const hydrationToken = threadHydrationEventBuffer.begin(input.threadId);
  useStore.getState().setThreadHydration(input.threadId, { status: "loadingOlder" });
  try {
    const detail = await input.api.orchestration.getSelectedThreadDetail({
      threadId: input.threadId,
      messageCursor: nextCursor,
    });
    const events = threadHydrationEventBuffer.finish(
      input.threadId,
      hydrationToken,
      detail.projectionSequence,
    );
    if (events !== null) {
      useStore.getState().syncSelectedThreadDetail(detail, true);
      applyReleasedThreadHydrationEvents(events);
    }
  } catch (error) {
    const events = threadHydrationEventBuffer.fail(input.threadId, hydrationToken);
    if (events !== null) {
      useStore.getState().setThreadHydration(input.threadId, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unable to load older messages.",
        retry: { kind: "older", nextCursor },
      });
      applyReleasedThreadHydrationEvents(events);
    }
  }
}

export async function loadMoreProjectThreadSummaries(input: {
  api: Api;
  projectId: GetProjectThreadSummariesResult["projectId"];
}): Promise<void> {
  const cursorByProjectId = useStore.getState().threadSummaryCursorByProjectId;
  if (!cursorByProjectId) {
    return;
  }
  const hasLoadedInitialPage = Object.hasOwn(cursorByProjectId, input.projectId);
  const cursor = cursorByProjectId[input.projectId];
  if (hasLoadedInitialPage && cursor === null) return;
  const page = await input.api.orchestration.getProjectThreadSummaries({
    projectId: input.projectId,
    limit: PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT,
    ...(cursor ? { cursor } : {}),
  });
  useStore.getState().appendProjectThreadSummaries(page);
}

export async function hydrateSelectedThread(input: {
  api: Api;
  threadId: ThreadId;
}): Promise<void> {
  const hydration = useStore.getState().threadHydrationById[input.threadId];
  if (hydration && hydration.status !== "unloaded" && hydration.status !== "failed") {
    return;
  }
  const hydrationToken = threadHydrationEventBuffer.begin(input.threadId);
  useStore.getState().setThreadHydration(input.threadId, { status: "loading" });
  try {
    const detail = await input.api.orchestration.getSelectedThreadDetail({
      threadId: input.threadId,
    });
    const events = threadHydrationEventBuffer.finish(
      input.threadId,
      hydrationToken,
      detail.projectionSequence,
    );
    if (events !== null) {
      useStore.getState().syncSelectedThreadDetail(detail, false);
      applyReleasedThreadHydrationEvents(events);
    }
  } catch (error) {
    const events = threadHydrationEventBuffer.fail(input.threadId, hydrationToken);
    if (events !== null) {
      useStore.getState().setThreadHydration(input.threadId, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unable to load the selected thread.",
        retry: { kind: "initial" },
      });
      applyReleasedThreadHydrationEvents(events);
    }
  }
}
