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
  remainingCount = 0,
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
    remainingCount,
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
    projectCatalogCursorByScope: { local: cursor1, remote: cursor2 },
    projectCatalogGenerationByScope: { local: 1, remote: 1 },
    projectCatalogLoadingByScope: { local: false, remote: false },
    projectCatalogErrorByScope: { local: undefined, remote: undefined },
    projectCatalogRetryHeadByScope: { local: false, remote: false },
    projectCatalogRestartProjectIdByScope: { local: null, remote: null },
    latestProjectEventSequenceById: {},
    projectThreadCountsById: {},
  });
});

describe("lazy project catalog pagination", () => {
  it("coalesces concurrent five-project requests", async () => {
    const { api, orchestration } = makeApi();
    const page = deferred<GetStartupProjectCatalogResult>();
    orchestration.getStartupProjectCatalog.mockReturnValueOnce(page.promise);

    const first = loadMoreProjectCatalog({ api, scope: "local" });
    const second = loadMoreProjectCatalog({ api, scope: "local" });

    expect(second).toBe(first);
    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
      scope: "local",
      limit: 5,
      cursor: cursor1,
    });
    page.resolve(makePage(project1));
    await first;

    expect(useStore.getState().projectCatalogCursorByScope.local).toBeNull();
    expect(useStore.getState().projectCatalogCursorByScope.remote).toEqual(cursor2);
  });

  it("loads local and remote pages independently", async () => {
    const { api, orchestration } = makeApi();
    const localPage = deferred<GetStartupProjectCatalogResult>();
    const remotePage = deferred<GetStartupProjectCatalogResult>();
    orchestration.getStartupProjectCatalog
      .mockReturnValueOnce(localPage.promise)
      .mockReturnValueOnce(remotePage.promise);

    const localLoad = loadMoreProjectCatalog({ api, scope: "local" });
    const remoteLoad = loadMoreProjectCatalog({ api, scope: "remote" });

    expect(remoteLoad).not.toBe(localLoad);
    expect(orchestration.getStartupProjectCatalog.mock.calls).toEqual([
      [{ scope: "local", limit: 5, cursor: cursor1 }],
      [{ scope: "remote", limit: 5, cursor: cursor2 }],
    ]);
    remotePage.resolve(makePage(project2));
    await remoteLoad;
    expect(useStore.getState().projectCatalogLoadingByScope.local).toBe(true);
    expect(useStore.getState().projectCatalogLoadingByScope.remote).toBe(false);

    localPage.resolve(makePage(project1));
    await localLoad;
    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project2, project1]);
  });

  it("stores remaining counts independently for each catalog scope", async () => {
    const { api, orchestration } = makeApi();
    orchestration.getStartupProjectCatalog
      .mockResolvedValueOnce(makePage(project1, cursor1, 6))
      .mockResolvedValueOnce(makePage(project2, cursor2, 3));

    await Promise.all([
      loadMoreProjectCatalog({ api, scope: "local" }),
      loadMoreProjectCatalog({ api, scope: "remote" }),
    ]);

    expect(useStore.getState().projectCatalogRemainingCountByScope).toEqual({
      local: 6,
      remote: 3,
    });
  });

  it("loads five projects from the catalog head after a single prioritized project", async () => {
    const { api, orchestration } = makeApi();
    useStore.getState().appendProjectCatalogPage("local", makePage(project1, cursor1));
    useStore.setState({
      projectCatalogRestartProjectIdByScope: { local: project1, remote: null },
    });
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project2));

    await loadMoreProjectCatalog({ api, scope: "local" });

    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
      scope: "local",
      limit: 6,
      priorityProjectId: project1,
    });
    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project1, project2]);
  });

  it("uses explicit restart priority after a same-scope project is inserted", async () => {
    const { api, orchestration } = makeApi();
    useStore.setState({
      projectCatalogRestartProjectIdByScope: { local: project1, remote: null },
    });
    useStore.getState().mergeProjectCatalogPage(makePage(project2));
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project2));

    await loadMoreProjectCatalog({ api, scope: "local" });

    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
      scope: "local",
      limit: 6,
      priorityProjectId: project1,
    });
    expect(useStore.getState().projectCatalogRestartProjectIdByScope.local).toBeNull();
  });

  it("uses explicit restart priority after a remote project is inserted", async () => {
    const { api, orchestration } = makeApi();
    useStore.setState({
      projectCatalogRestartProjectIdByScope: { local: null, remote: project1 },
    });
    useStore.getState().mergeProjectCatalogPage(makePage(project2));
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project2));

    await loadMoreProjectCatalog({ api, scope: "remote" });

    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
      scope: "remote",
      limit: 6,
      priorityProjectId: project1,
    });
    expect(useStore.getState().projectCatalogRestartProjectIdByScope.remote).toBeNull();
  });

  it("retries a failed bootstrap scope from the catalog head", async () => {
    const { api, orchestration } = makeApi();
    useStore.setState({
      projectCatalogCursorByScope: { local: cursor1, remote: null },
      projectCatalogRetryHeadByScope: { local: false, remote: true },
      projectCatalogErrorByScope: { local: undefined, remote: "offline" },
    });
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project2));

    await loadMoreProjectCatalog({ api, scope: "remote" });

    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
      scope: "remote",
      limit: 5,
    });
    expect(useStore.getState().projectCatalogRetryHeadByScope.remote).toBe(false);
  });

  it("contains a rejected page to its scope, preserves state, and retries", async () => {
    const { api, orchestration } = makeApi();
    useStore.getState().appendProjectCatalogPage("remote", makePage(project2, cursor2), 1);
    useStore.setState({
      projectCatalogCursorByScope: { local: cursor1, remote: cursor2 },
      projectCatalogErrorByScope: { local: undefined, remote: "remote warning" },
    });
    orchestration.getStartupProjectCatalog.mockRejectedValueOnce(new Error("offline"));

    await expect(loadMoreProjectCatalog({ api, scope: "local" })).rejects.toThrow("offline");

    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project2]);
    expect(useStore.getState().projectCatalogCursorByScope.local).toEqual(cursor1);
    expect(useStore.getState().projectCatalogCursorByScope.remote).toEqual(cursor2);
    expect(useStore.getState().projectCatalogGenerationByScope).toEqual({ local: 1, remote: 1 });
    expect(useStore.getState().projectCatalogErrorByScope.local).toBe("offline");
    expect(useStore.getState().projectCatalogErrorByScope.remote).toBe("remote warning");
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project1));
    await loadMoreProjectCatalog({ api, scope: "local" });

    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledTimes(2);
    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project2, project1]);
    expect(useStore.getState().projectCatalogErrorByScope.local).toBeUndefined();
    expect(useStore.getState().projectCatalogErrorByScope.remote).toBe("remote warning");
  });

  it("loads every remaining page only for the explicit load-all action", async () => {
    const { api, orchestration } = makeApi();
    orchestration.getStartupProjectCatalog
      .mockResolvedValueOnce(makePage(project1, cursor2))
      .mockResolvedValueOnce(makePage(project2));

    await loadAllProjectCatalog({ api, scope: "local" });

    expect(orchestration.getStartupProjectCatalog.mock.calls).toEqual([
      [{ scope: "local", limit: 20, cursor: cursor1 }],
      [{ scope: "local", limit: 20, cursor: cursor2 }],
    ]);
    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project1, project2]);
  });

  it("ignores a superseded page result", async () => {
    const { api, orchestration } = makeApi();
    const stalePage = deferred<GetStartupProjectCatalogResult>();
    orchestration.getStartupProjectCatalog.mockReturnValueOnce(stalePage.promise);

    const staleLoad = loadMoreProjectCatalog({ api, scope: "local" });
    useStore.setState({
      projectCatalogCursorByScope: { local: cursor2, remote: cursor2 },
      projectCatalogGenerationByScope: { local: 2, remote: 1 },
      projectCatalogLoadingByScope: { local: false, remote: false },
    });
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project2));
    await loadMoreProjectCatalog({ api, scope: "local" });
    stalePage.resolve(makePage(project1, cursor1));
    await staleLoad;

    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project2]);
    expect(useStore.getState().projectCatalogCursorByScope.local).toBeNull();
  });

  it("ignores a superseded page failure", async () => {
    const { api, orchestration } = makeApi();
    const stalePage = deferred<GetStartupProjectCatalogResult>();
    orchestration.getStartupProjectCatalog.mockReturnValueOnce(stalePage.promise);

    const staleLoad = loadMoreProjectCatalog({ api, scope: "local" });
    useStore.setState({
      projectCatalogCursorByScope: { local: cursor2, remote: cursor2 },
      projectCatalogGenerationByScope: { local: 2, remote: 1 },
      projectCatalogLoadingByScope: { local: false, remote: false },
      projectCatalogErrorByScope: { local: undefined, remote: undefined },
    });
    orchestration.getStartupProjectCatalog.mockResolvedValueOnce(makePage(project2));
    await loadMoreProjectCatalog({ api, scope: "local" });
    stalePage.reject(new Error("old failure"));
    await expect(staleLoad).rejects.toThrow("old failure");

    expect(useStore.getState().projectCatalogErrorByScope.local).toBeUndefined();
    expect(useStore.getState().projectCatalogLoadingByScope.local).toBe(false);
  });
});
