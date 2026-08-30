import {
  PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT,
  STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT,
  ThreadId,
  type GetProjectThreadSummariesResult,
  type GetSelectedThreadDetailResult,
  type GetStartupProjectCatalogResult,
  type ProjectCatalogScope,
  type ProjectId,
} from "@bigbud/contracts";

import type { readNativeApi } from "../rpc/nativeApi";
import { useStore } from "../stores/main";
import {
  applyReleasedThreadHydrationEvents,
  threadHydrationEventBuffer,
} from "../logic/orchestration/thread-hydration-events.logic";

type Api = NonNullable<ReturnType<typeof readNativeApi>>;
const STARTUP_LOCAL_PROJECT_CATALOG_LIMIT = 2;
export {
  loadAllProjectCatalog,
  loadMoreProjectCatalog,
} from "./-__root.bounded-bootstrap.projects";

export function resolveSelectedThreadIdFromPath(
  pathname: string,
  fallback: ThreadId | null,
): ThreadId | null {
  if (
    !/^\/[^/]+$/.test(pathname) ||
    pathname === "/automations" ||
    pathname === "/plugins" ||
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

    const priorityProjectId = selectedDetail?.projectId;
    const scopes = ["local", "remote"] as const;
    const [sidebarCatalog, catalogResults] = await Promise.all([
      sidebarCatalogPromise,
      Promise.allSettled(
        scopes.map((scope) =>
          input.api.orchestration.getStartupProjectCatalog({
            scope,
            limit:
              scope === "local"
                ? STARTUP_LOCAL_PROJECT_CATALOG_LIMIT
                : STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT,
            ...(priorityProjectId ? { priorityProjectId } : {}),
          }),
        ),
      ),
    ]);
    const catalogs: Partial<Record<ProjectCatalogScope, GetStartupProjectCatalogResult>> = {};
    const catalogErrors: Partial<Record<ProjectCatalogScope, string>> = {};
    const catalogRestartProjectIds: Partial<Record<ProjectCatalogScope, ProjectId>> = {};
    sequences.push(sidebarCatalog.projectionSequence);
    for (const [index, result] of catalogResults.entries()) {
      const scope = scopes[index]!;
      if (result.status === "fulfilled") {
        catalogs[scope] = result.value;
        if (
          priorityProjectId &&
          result.value.projects.some((project) => project.id === priorityProjectId)
        ) {
          catalogRestartProjectIds[scope] = priorityProjectId;
        }
        sequences.push(result.value.projectionSequence);
      } else {
        catalogErrors[scope] =
          result.reason instanceof Error ? result.reason.message : "Unable to load projects.";
      }
    }

    const selectedProjectId = selectedDetail?.projectId;
    const selectedProjectPage =
      selectedProjectId !== undefined &&
      Object.values(catalogs).some((catalog) =>
        catalog.projects.some((project) => project.id === selectedProjectId),
      )
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
        catalogs,
        catalogErrors,
        catalogRestartProjectIds,
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
