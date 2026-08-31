import {
  STARTUP_PROJECT_CATALOG_MAX_LIMIT,
  type GetStartupProjectCatalogResult,
  type ProjectCatalogScope,
  type ProjectId,
} from "@bigbud/contracts";

import type { readNativeApi } from "../rpc/nativeApi";
import { useStore } from "../stores/main";

type Api = NonNullable<ReturnType<typeof readNativeApi>>;
type ProjectCatalogCursor = NonNullable<GetStartupProjectCatalogResult["nextCursor"]>;

const PROJECT_CATALOG_PAGE_LIMIT = 5;

interface ProjectCatalogPageLoad {
  readonly scope: ProjectCatalogScope;
  readonly cursor: ProjectCatalogCursor | null;
  readonly generation: number;
  readonly limit: number;
  readonly loadAll: boolean;
  readonly restartProjectId: ProjectId | null;
  promise: Promise<void>;
}

const projectCatalogPageLoads: Record<ProjectCatalogScope, ProjectCatalogPageLoad | null> = {
  local: null,
  remote: null,
};

export function loadMoreProjectCatalog(input: {
  api: Api;
  scope: ProjectCatalogScope;
}): Promise<void> {
  return loadProjectCatalog(input, { limit: PROJECT_CATALOG_PAGE_LIMIT, loadAll: false });
}

export function loadAllProjectCatalog(input: {
  api: Api;
  scope: ProjectCatalogScope;
}): Promise<void> {
  return loadProjectCatalog(input, { limit: STARTUP_PROJECT_CATALOG_MAX_LIMIT, loadAll: true });
}

function loadProjectCatalog(
  input: { api: Api; scope: ProjectCatalogScope },
  options: { readonly limit: number; readonly loadAll: boolean },
): Promise<void> {
  const state = useStore.getState();
  const retryHead = state.projectCatalogRetryHeadByScope[input.scope];
  const cursor = state.projectCatalogCursorByScope[input.scope];
  if (!retryHead && (cursor === null || cursor === undefined)) {
    return Promise.resolve();
  }

  const currentLoad = projectCatalogPageLoads[input.scope];
  if (
    currentLoad !== null &&
    currentLoad.generation === state.projectCatalogGenerationByScope[input.scope]
  ) {
    return currentLoad.promise;
  }

  const request: ProjectCatalogPageLoad = {
    scope: input.scope,
    cursor: cursor ?? null,
    generation: state.projectCatalogGenerationByScope[input.scope],
    limit: options.limit,
    loadAll: options.loadAll,
    restartProjectId: state.projectCatalogRestartProjectIdByScope[input.scope],
    promise: Promise.resolve(),
  };
  useStore.getState().setProjectCatalogLoading(input.scope, true, undefined, request.generation);
  projectCatalogPageLoads[input.scope] = request;
  request.promise = loadProjectCatalogPages(input.api, request)
    .catch((error: unknown) => {
      useStore
        .getState()
        .setProjectCatalogLoading(
          input.scope,
          false,
          error instanceof Error ? error.message : "Unable to load projects.",
          request.generation,
        );
      throw error;
    })
    .finally(() => {
      if (projectCatalogPageLoads[input.scope] === request) {
        projectCatalogPageLoads[input.scope] = null;
      }
    });
  return request.promise;
}

async function loadProjectCatalogPages(api: Api, request: ProjectCatalogPageLoad): Promise<void> {
  let cursor = request.cursor;
  let restartProjectId = request.restartProjectId;
  let attempt = 0;

  do {
    attempt += 1;
    const rpcInput =
      restartProjectId === null
        ? { scope: request.scope, limit: request.limit, ...(cursor ? { cursor } : {}) }
        : {
            scope: request.scope,
            limit: Math.min(request.limit + 1, STARTUP_PROJECT_CATALOG_MAX_LIMIT),
            priorityProjectId: restartProjectId,
          };
    const diagnostic = {
      scope: request.scope,
      limit: rpcInput.limit,
      cursorPresent: "cursor" in rpcInput,
      attempt,
    };
    const startedAt = performance.now();
    if (import.meta.env.MODE !== "test") {
      console.info("[project-catalog] Page request started.", diagnostic);
    }
    let page: GetStartupProjectCatalogResult;
    try {
      page = await api.orchestration.getStartupProjectCatalog(rpcInput);
    } catch (error) {
      if (import.meta.env.MODE !== "test") {
        console.warn("[project-catalog] Page request failed.", {
          ...diagnostic,
          outcome: "failure",
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
      throw error;
    }
    if (import.meta.env.MODE !== "test") {
      console.info("[project-catalog] Page request completed.", {
        ...diagnostic,
        outcome: "success",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    }
    if (useStore.getState().projectCatalogGenerationByScope[request.scope] !== request.generation) {
      return;
    }

    const hasMorePages = page.nextCursor !== null && page.nextCursor !== undefined;
    useStore
      .getState()
      .appendProjectCatalogPage(
        request.scope,
        page,
        request.generation,
        request.loadAll && hasMorePages,
      );
    if (!request.loadAll) {
      return;
    }
    cursor = page.nextCursor ?? null;
    restartProjectId = null;
  } while (cursor !== null);
}
