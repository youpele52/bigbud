import {
  PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT,
  STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT,
  STARTUP_PROJECT_CATALOG_MAX_LIMIT,
  ThreadId,
  type ProjectId,
  type GetProjectThreadSummariesResult,
  type GetSelectedThreadDetailResult,
  type GetStartupProjectCatalogResult,
} from "@bigbud/contracts";

import type { readNativeApi } from "../rpc/nativeApi";
import { useStore } from "../stores/main";
import {
  applyReleasedThreadHydrationEvents,
  threadHydrationEventBuffer,
} from "../logic/orchestration/thread-hydration-events.logic";

type Api = NonNullable<ReturnType<typeof readNativeApi>>;
type ProjectCatalogCursor = NonNullable<GetStartupProjectCatalogResult["nextCursor"]>;

const PROJECT_CATALOG_PAGE_LIMIT = 5;

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
  let selectedDetail: GetSelectedThreadDetailResult | null = null;
  let selectedDetailError: unknown = null;
  const hydrationToken =
    input.selectedThreadId === null
      ? null
      : threadHydrationEventBuffer.begin(input.selectedThreadId);
  const sidebarCatalogPromise = input.api.orchestration.getSidebarThreadCatalog();
  const selectedDetailPromise =
    input.selectedThreadId === null
      ? null
      : (useStore.getState().setThreadHydration(input.selectedThreadId, { status: "loading" }),
        input.api.orchestration.getSelectedThreadDetail({ threadId: input.selectedThreadId }));

  try {
    if (selectedDetailPromise !== null) {
      try {
        selectedDetail = await selectedDetailPromise;
        sequences.push(selectedDetail.projectionSequence);
      } catch (error) {
        selectedDetailError = error;
      }
    }

    const [sidebarCatalog, catalog] = await Promise.all([
      sidebarCatalogPromise,
      input.api.orchestration.getStartupProjectCatalog({
        limit: STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT,
        ...(selectedDetail ? { priorityProjectId: selectedDetail.projectId } : {}),
      }),
    ]);
    sequences.push(sidebarCatalog.projectionSequence, catalog.projectionSequence);

    const selectedProjectId = selectedDetail?.projectId;
    const selectedProjectPage =
      selectedProjectId !== undefined &&
      catalog.projects.some((project) => project.id === selectedProjectId)
        ? await input.api.orchestration.getProjectThreadSummaries({
            projectId: selectedProjectId,
            limit: PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT,
            priorityThreadId: input.selectedThreadId!,
          })
        : null;
    if (selectedProjectPage) {
      sequences.push(selectedProjectPage.projectionSequence);
    }

    if (!input.disposed()) {
      const store = useStore.getState();
      store.syncBoundedCatalog(
        catalog,
        sidebarCatalog,
        selectedProjectPage ? [selectedProjectPage] : [],
      );
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

  return Math.min(...sequences);
}

interface ProjectCatalogPageLoad {
  readonly cursor: ProjectCatalogCursor;
  readonly generation: number;
  readonly limit: number;
  readonly loadAll: boolean;
  readonly restartProjectId: ProjectId | null;
  promise: Promise<void>;
}

let projectCatalogPageLoad: ProjectCatalogPageLoad | null = null;

export function loadMoreProjectCatalog(input: { api: Api }): Promise<void> {
  return loadProjectCatalog(input, { limit: PROJECT_CATALOG_PAGE_LIMIT, loadAll: false });
}

export function loadAllProjectCatalog(input: { api: Api }): Promise<void> {
  return loadProjectCatalog(input, { limit: STARTUP_PROJECT_CATALOG_MAX_LIMIT, loadAll: true });
}

function loadProjectCatalog(
  input: { api: Api },
  options: { readonly limit: number; readonly loadAll: boolean },
): Promise<void> {
  const state = useStore.getState();
  const cursor = state.projectCatalogCursor;
  if (cursor === null || cursor === undefined) {
    return Promise.resolve();
  }

  if (
    projectCatalogPageLoad !== null &&
    projectCatalogPageLoad.generation === state.projectCatalogGeneration
  ) {
    return projectCatalogPageLoad.promise;
  }

  const request: ProjectCatalogPageLoad = {
    cursor,
    generation: state.projectCatalogGeneration,
    limit: options.limit,
    loadAll: options.loadAll,
    restartProjectId:
      state.projects.length === 1 && state.projects[0]?.id === cursor.projectId
        ? state.projects[0].id
        : null,
    promise: Promise.resolve(),
  };
  useStore.getState().setProjectCatalogLoading(true, undefined, request.generation);
  projectCatalogPageLoad = request;
  request.promise = loadProjectCatalogPages(input.api, request)
    .catch((error: unknown) => {
      useStore
        .getState()
        .setProjectCatalogLoading(
          false,
          error instanceof Error ? error.message : "Unable to load projects.",
          request.generation,
        );
      throw error;
    })
    .finally(() => {
      if (projectCatalogPageLoad === request) {
        projectCatalogPageLoad = null;
      }
    });
  return request.promise;
}

async function loadProjectCatalogPages(api: Api, request: ProjectCatalogPageLoad): Promise<void> {
  let cursor: ProjectCatalogCursor | null = request.cursor;
  let restartProjectId = request.restartProjectId;

  while (cursor !== null) {
    const page = await api.orchestration.getStartupProjectCatalog(
      restartProjectId === null
        ? { limit: request.limit, cursor }
        : {
            limit: Math.min(request.limit + 1, STARTUP_PROJECT_CATALOG_MAX_LIMIT),
            priorityProjectId: restartProjectId,
          },
    );
    if (useStore.getState().projectCatalogGeneration !== request.generation) {
      return;
    }

    const hasMorePages = page.nextCursor !== null && page.nextCursor !== undefined;
    useStore
      .getState()
      .appendProjectCatalogPage(page, request.generation, request.loadAll && hasMorePages);
    if (!request.loadAll) {
      return;
    }
    cursor = page.nextCursor ?? null;
    restartProjectId = null;
  }
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
