import { ProjectId, type GetStartupProjectCatalogResult, type NativeApi } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../stores/main";
import { loadAllProjectCatalog, loadMoreProjectCatalog } from "./-__root.bounded-bootstrap";

const project1 = ProjectId.makeUnsafe("project-1");
const project2 = ProjectId.makeUnsafe("project-2");
const cursor1 = { lastUsedAt: "2026-08-10T00:00:00.000Z", projectId: project1 };
const cursor2 = { lastUsedAt: "2026-08-09T00:00:00.000Z", projectId: project2 };

function makePage(
  projectId: ProjectId,
  nextCursor: GetStartupProjectCatalogResult["nextCursor"] = undefined,
): GetStartupProjectCatalogResult {
  return {
    projectionSequence: 10,
    projects: [
      {
        id: projectId,
        title: `Project ${projectId}`,
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "local",
        executionTargetId: "local",
        workspaceRoot: `/tmp/${projectId}`,
        lastUsedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        deletingAt: null,
        threadCount: 0,
        exceptionalThreadCount: 0,
        hasExceptionalThreads: false,
      },
    ],
    nextCursor,
  };
}

function makeApi() {
  const orchestration = { getStartupProjectCatalog: vi.fn() };
  return { api: { orchestration } as unknown as NativeApi, orchestration };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useStore.setState({
    projects: [],
    projectCatalogCursor: cursor1,
    projectCatalogGeneration: 1,
    projectCatalogLoading: false,
    projectCatalogError: undefined,
    latestProjectEventSequenceById: {},
    projectThreadCountsById: {},
  });
});

describe("lazy project catalog pagination", () => {
  it("coalesces concurrent five-project requests", async () => {
    const { api, orchestration } = makeApi();
    const page = deferred<GetStartupProjectCatalogResult>();
    orchestration.getStartupProjectCatalog.mockReturnValueOnce(page.promise);

    const first = loadMoreProjectCatalog({ api });
    const second = loadMoreProjectCatalog({ api });

    expect(second).toBe(first);
    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
      limit: 5,
      cursor: cursor1,
    });
    page.resolve(makePage(project1));
    await first;

    expect(useStore.getState().projectCatalogCursor).toBeNull();
  });

  it("loads five projects from the catalog head after a single prioritized project", async () => {
    const { api, orchestration } = makeApi();
    useStore.getState().appendProjectCatalogPage(makePage(project1, cursor1));
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project2));

    await loadMoreProjectCatalog({ api });

    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
      limit: 6,
      priorityProjectId: project1,
    });
    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project1, project2]);
  });

  it("preserves the cursor after failure and retries", async () => {
    const { api, orchestration } = makeApi();
    orchestration.getStartupProjectCatalog.mockRejectedValueOnce(new Error("offline"));

    await expect(loadMoreProjectCatalog({ api })).rejects.toThrow("offline");

    expect(useStore.getState().projectCatalogCursor).toEqual(cursor1);
    expect(useStore.getState().projectCatalogError).toBe("offline");
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project1));
    await loadMoreProjectCatalog({ api });

    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledTimes(2);
    expect(useStore.getState().projectCatalogError).toBeUndefined();
  });

  it("loads every remaining page only for the explicit load-all action", async () => {
    const { api, orchestration } = makeApi();
    orchestration.getStartupProjectCatalog
      .mockResolvedValueOnce(makePage(project1, cursor2))
      .mockResolvedValueOnce(makePage(project2));

    await loadAllProjectCatalog({ api });

    expect(orchestration.getStartupProjectCatalog.mock.calls).toEqual([
      [{ limit: 20, cursor: cursor1 }],
      [{ limit: 20, cursor: cursor2 }],
    ]);
    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project1, project2]);
  });

  it("ignores a superseded page result", async () => {
    const { api, orchestration } = makeApi();
    const stalePage = deferred<GetStartupProjectCatalogResult>();
    orchestration.getStartupProjectCatalog.mockReturnValueOnce(stalePage.promise);

    const staleLoad = loadMoreProjectCatalog({ api });
    useStore.setState({
      projectCatalogCursor: cursor2,
      projectCatalogGeneration: 2,
      projectCatalogLoading: false,
    });
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project2));
    await loadMoreProjectCatalog({ api });
    stalePage.resolve(makePage(project1, cursor1));
    await staleLoad;

    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project2]);
    expect(useStore.getState().projectCatalogCursor).toBeNull();
  });

  it("ignores a superseded page failure", async () => {
    const { api, orchestration } = makeApi();
    const stalePage = deferred<GetStartupProjectCatalogResult>();
    orchestration.getStartupProjectCatalog.mockReturnValueOnce(stalePage.promise);

    const staleLoad = loadMoreProjectCatalog({ api });
    useStore.setState({
      projectCatalogCursor: cursor2,
      projectCatalogGeneration: 2,
      projectCatalogLoading: false,
      projectCatalogError: undefined,
    });
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project2));
    await loadMoreProjectCatalog({ api });
    stalePage.reject(new Error("old failure"));
    await expect(staleLoad).rejects.toThrow("old failure");

    expect(useStore.getState().projectCatalogError).toBeUndefined();
    expect(useStore.getState().projectCatalogLoading).toBe(false);
  });
});
