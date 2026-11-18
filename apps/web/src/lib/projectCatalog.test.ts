import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import type { GetStartupProjectCatalogResult } from "@bigbud/contracts/orchestration/orchestration.catalog";
import { loadProjectById } from "./projectCatalog";
import { retainProjectDependency } from "./projectDependencies";
import {
  recordWsConnectionAttempt,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { useStore } from "../stores/main";
import { makeEvent } from "../stores/main/main.store.test.helpers";
import {
  chatsPage,
  emptyPage,
  deferredProjectPage,
  resetProjectGateStore,
} from "../components/chat/view/ThreadProjectGate.test-helpers";

const projectId = ProjectId.makeUnsafe("arbitrary-existing-project");
function page(scope: "local" | "remote", sequence = 10): GetStartupProjectCatalogResult {
  return {
    ...emptyPage,
    projectionSequence: sequence,
    projects: [
      {
        ...chatsPage.projects[0]!,
        id: projectId,
        title: `Project ${sequence}`,
        workspaceRoot: "/workspace/arbitrary",
        workspaceExecutionTargetId: scope === "local" ? "local" : "ssh-target",
      },
    ],
  };
}
function start(
  getStartupProjectCatalog: Parameters<
    typeof loadProjectById
  >[0]["api"]["orchestration"]["getStartupProjectCatalog"],
  extra = {},
) {
  return loadProjectById({
    api: { orchestration: { getStartupProjectCatalog } },
    projectId,
    getProject: () => useStore.getState().projects.find((project) => project.id === projectId),
    mergeProjectCatalogPage: useStore.getState().mergeProjectCatalogPage,
    timeoutMs: 30,
    ...extra,
  });
}
beforeEach(() => {
  resetProjectGateStore();
  resetWsConnectionStateForTests();
});
afterEach(() => {
  vi.useRealTimers();
  resetProjectGateStore();
});

describe("bounded project dependency reads", () => {
  it.each(["local", "remote"] as const)(
    "resolves %s without waiting for the other scope",
    async (scope) => {
      const stalled = deferredProjectPage();
      const read = vi.fn(({ scope: requested }) =>
        requested === scope ? Promise.resolve(page(scope)) : stalled.promise,
      );
      await expect(start(read)).resolves.toMatchObject({ id: projectId });
      expect(read).toHaveBeenCalledWith({ scope, priorityProjectId: projectId, limit: 1 });
      stalled.resolve(page(scope, 99));
      await Promise.resolve();
      expect(useStore.getState().projects[0]?.name).toBe("Project 10");
    },
  );

  it("distinguishes definitive absence from a failed scope", async () => {
    await expect(start(vi.fn(async () => emptyPage))).resolves.toBeUndefined();
    await expect(
      start(
        vi.fn(async ({ scope }) => {
          if (scope === "remote") throw new Error("disconnected");
          return emptyPage;
        }),
      ),
    ).rejects.toThrow("disconnected");
  });

  it("times out and fences a late result", async () => {
    vi.useFakeTimers();
    const stalled = deferredProjectPage();
    const result = start(vi.fn(() => stalled.promise));
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(31);
    await rejected;
    stalled.resolve(page("local"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useStore.getState().projects).toEqual([]);
  });

  it("fresh retry retires old work and old cleanup cannot remove the new flight", async () => {
    const old = deferredProjectPage();
    const current = deferredProjectPage();
    const read = vi.fn(() => old.promise);
    const api = { orchestration: { getStartupProjectCatalog: read } };
    const first = start(read, { api });
    const rejected = expect(first).rejects.toThrow("superseded");
    await Promise.resolve();
    read.mockImplementation(() => current.promise);
    const second = start(read, { api, fresh: true });
    await rejected;
    const third = start(read, { api });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(4);
    old.resolve(page("local", 99));
    current.resolve(page("local", 20));
    await expect(second).resolves.toMatchObject({ name: "Project 20" });
    await expect(third).resolves.toMatchObject({ name: "Project 20" });
  });

  it("does not share work across APIs or store merge owners", async () => {
    const stalled = deferredProjectPage();
    const first = start(vi.fn(() => stalled.promise));
    await expect(start(vi.fn(async () => page("local")))).resolves.toMatchObject({ id: projectId });
    resetProjectGateStore();
    const read = vi.fn(async () => page("local"));
    const merge = vi.fn((result) => useStore.getState().mergeProjectCatalogPage(result));
    await expect(start(read, { mergeProjectCatalogPage: merge })).resolves.toBeDefined();
    expect(merge).toHaveBeenCalledOnce();
    stalled.resolve(emptyPage);
    await first;
  });

  it("isolates concurrent merge owners even when they share the same API", async () => {
    const stalled = deferredProjectPage();
    const read = vi
      .fn<
        Parameters<typeof loadProjectById>[0]["api"]["orchestration"]["getStartupProjectCatalog"]
      >()
      .mockImplementationOnce(() => stalled.promise)
      .mockImplementationOnce(() => stalled.promise)
      .mockResolvedValue(page("local"));
    const api = { orchestration: { getStartupProjectCatalog: read } };
    const firstMerge = vi.fn(useStore.getState().mergeProjectCatalogPage);
    const first = start(read, { api, mergeProjectCatalogPage: firstMerge, timeoutMs: 1_000 });
    await Promise.resolve();
    const secondMerge = vi.fn(useStore.getState().mergeProjectCatalogPage);
    await expect(start(read, { api, mergeProjectCatalogPage: secondMerge })).resolves.toBeDefined();
    expect(secondMerge).toHaveBeenCalledOnce();
    expect(firstMerge).not.toHaveBeenCalled();
    stalled.resolve(emptyPage);
    await expect(first).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("rejects a response from an older connection attempt", async () => {
    const stalled = deferredProjectPage();
    const result = start(vi.fn(() => stalled.promise));
    recordWsConnectionAttempt("ws://new-server/ws");
    stalled.resolve(page("local"));
    await expect(result).rejects.toThrow("superseded");
    expect(useStore.getState().projects).toEqual([]);
  });
});

describe("project catalog dependency invariants", () => {
  it("does not roll newer catalog metadata back on out-of-order replies", () => {
    const store = useStore.getState();
    store.mergeProjectCatalogPage(page("local", 20));
    store.mergeProjectCatalogPage(page("local", 10));
    expect(useStore.getState().projects[0]?.name).toBe("Project 20");
  });

  it.each(["local", "remote"] as const)(
    "retains a mounted %s dependency, then releases it",
    (scope) => {
      useStore.getState().mergeProjectCatalogPage(page(scope));
      const release = retainProjectDependency(projectId);
      const replace = () =>
        useStore
          .getState()
          .syncBoundedCatalog(
            { [scope]: { ...emptyPage, projectionSequence: 30 } },
            {},
            {},
            { projectionSequence: 30, threads: [], recentThreadIds: [], pinnedThreadIds: [] },
            [],
          );
      replace();
      expect(useStore.getState().projects.some((project) => project.id === projectId)).toBe(true);
      release();
      replace();
      expect(useStore.getState().projects.some((project) => project.id === projectId)).toBe(false);
    },
  );

  it("deletion removes an already-retained dependency and a stale page cannot restore it", () => {
    useStore.getState().mergeProjectCatalogPage(page("local", 10));
    const release = retainProjectDependency(projectId);
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.deleted",
          { projectId, deletedAt: "2026-11-09T00:00:00.000Z" },
          { sequence: 30 },
        ),
      );
    expect(useStore.getState().projects).toEqual([]);
    useStore.getState().mergeProjectCatalogPage(page("local", 20));
    expect(useStore.getState().projects).toEqual([]);
    release();
  });

  it("does not resurrect a deleted dependency from a late catalog", () => {
    const release = retainProjectDependency(projectId);
    useStore.setState({ deletedProjectSequenceById: { [projectId]: 30 } });
    useStore.getState().mergeProjectCatalogPage(page("local", 20));
    expect(useStore.getState().projects).toEqual([]);
    release();
  });
});
