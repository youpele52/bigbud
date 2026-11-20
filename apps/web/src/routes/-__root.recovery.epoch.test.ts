import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GetSelectedThreadDetailResult } from "@bigbud/contracts";
import { createEventRouterRecovery } from "./-__root.recovery";
import { hydrateSelectedThread } from "./-__root.bounded-bootstrap";
import { useStore } from "../stores/main";
import {
  createProjectGateApi,
  resetProjectGateStore,
  otherProjectId,
  deferredProjectPage,
  emptyPage,
  recentId,
  otherId,
} from "../components/chat/view/ThreadProjectGate.test-helpers";
import {
  makeEvent,
  makeReadModel,
  makeReadModelThread,
} from "../stores/main/main.store.test.helpers";
import { retainProjectDependency } from "../lib/projectDependencies";
import { loadProjectById } from "../lib/projectCatalog";
import {
  threadHydrationEventBuffer,
  setThreadHydrationEventApplier,
} from "../logic/orchestration/thread-hydration-events.logic";

vi.mock("./-__root.ownership-reconciliation", () => ({
  reconcileAppliedCanonicalOwnership: vi.fn(async () => undefined),
}));

const recoveries: ReturnType<typeof createEventRouterRecovery>[] = [];
function setup() {
  const { api, orchestration } = createProjectGateApi();
  const recovery = createEventRouterRecovery({
    api,
    queryClient: new QueryClient(),
    clearAllThinkingDeltas: vi.fn(),
    reconcileThinkingActivities: vi.fn(),
    applyOrchestrationEvents: (events) => useStore.getState().applyOrchestrationEvents(events),
    syncProjects: vi.fn(),
    syncThreads: vi.fn(),
    clearThreadUi: vi.fn(),
    removeFromSelection: vi.fn(),
    removeTerminalState: vi.fn(),
    removeOrphanedTerminalStates: vi.fn(),
    applyTerminalEvent: vi.fn(),
  });
  recoveries.push(recovery);
  return { recovery, api, orchestration };
}

beforeEach(() => {
  resetProjectGateStore();
  threadHydrationEventBuffer.clear();
});
afterEach(() => {
  for (const recovery of recoveries.splice(0)) recovery.cancel();
  threadHydrationEventBuffer.clear();
  setThreadHydrationEventApplier(null);
});

it("rebases the active delivery baseline from epoch sequence 100 to 10 and admits new low-sequence events", async () => {
  const { recovery, orchestration } = setup();
  await recovery.runDeliveryBaselineRecovery(null, () => false, "old-db");
  useStore.setState({
    projects: useStore
      .getState()
      .projects.map((project) =>
        Object.assign({}, project, { name: "Old database", cwd: "/old-db" }),
      ),
    projectCatalogSequenceById: { [otherProjectId]: 100 },
    latestProjectEventSequenceById: { [otherProjectId]: 100 },
    pendingUnloadedProjectPatchById: {
      [otherProjectId]: { sequence: 100, patch: { name: "Old patch" } },
    },
  });
  const release = retainProjectDependency(otherProjectId);
  // Advance the coordinator as well as the metadata fences.
  orchestration.getSidebarThreadCatalog.mockResolvedValueOnce({
    projectionSequence: 100,
    threads: [],
    recentThreadIds: [],
    pinnedThreadIds: [],
  });
  await recovery.runDeliveryBaselineRecovery(null, () => false, "old-db");
  // Snapshot completion uses the minimum page sequence; explicitly apply contiguous events to 100.
  await recovery.applyEventBatch(
    Array.from({ length: 90 }, (_, index) =>
      makeEvent(
        "project.meta-updated",
        {
          projectId: otherProjectId,
          title: "Old database",
          updatedAt: "2026-11-09T00:00:00.000Z",
        },
        { sequence: index + 11 },
      ),
    ),
    { refresh: false },
  );
  expect(recovery.getAppliedSequence()).toBe(100);
  await expect(
    recovery.runDeliveryBaselineRecovery(null, () => false, "replacement-db"),
  ).resolves.toBe(10);
  expect(
    useStore.getState().projects.find((project) => project.id === otherProjectId),
  ).toMatchObject({
    name: otherProjectId,
    cwd: `/tmp/${otherProjectId}`,
  });
  expect(useStore.getState().pendingUnloadedProjectPatchById).toEqual({});
  expect(useStore.getState().projectDependencyRefCounts?.[otherProjectId]).toBe(1);
  expect(recovery.getAppliedSequence()).toBe(10);
  expect(recovery.classifyDomainEvent(11)).toBe("apply");
  await recovery.applyEventBatch(
    [
      makeEvent(
        "project.meta-updated",
        {
          projectId: otherProjectId,
          title: "New database event",
          updatedAt: "2026-11-09T00:00:01.000Z",
        },
        { sequence: 11 },
      ),
    ],
    { refresh: false },
  );
  expect(useStore.getState().projects.find((project) => project.id === otherProjectId)?.name).toBe(
    "New database event",
  );
  release();
});

it("clears old deletion tombstones only on an authoritative epoch change", async () => {
  const { recovery } = setup();
  await recovery.runDeliveryBaselineRecovery(null, () => false, "old-db");
  useStore.getState().applyOrchestrationEvent(
    makeEvent(
      "project.deleted",
      {
        projectId: otherProjectId,
        deletedAt: "2026-11-09T00:00:00.000Z",
      },
      { sequence: 100 },
    ),
  );
  await recovery.runDeliveryBaselineRecovery(null, () => false, "old-db");
  expect(useStore.getState().projects.some((project) => project.id === otherProjectId)).toBe(false);
  expect(useStore.getState().deletedProjectSequenceById?.[otherProjectId]).toBe(100);
  await recovery.runDeliveryBaselineRecovery(null, () => false, "replacement-db");
  expect(useStore.getState().projects.some((project) => project.id === otherProjectId)).toBe(true);
  expect(useStore.getState().deletedProjectSequenceById).toEqual({});
});

it("rebases a second surface's coordinator even if the shared store already adopted the epoch", async () => {
  const first = setup().recovery;
  const second = setup().recovery;
  await first.runDeliveryBaselineRecovery(null, () => false, "old-db");
  await second.runDeliveryBaselineRecovery(null, () => false, "old-db");
  await second.applyEventBatch(
    [
      makeEvent(
        "project.meta-updated",
        {
          projectId: otherProjectId,
          title: "Old event",
          updatedAt: "2026-11-09T00:00:00.000Z",
        },
        { sequence: 11 },
      ),
    ],
    { refresh: false },
  );
  await first.runDeliveryBaselineRecovery(null, () => false, "replacement-db");
  const generations = useStore.getState().projectCatalogGenerationByScope;
  await second.runDeliveryBaselineRecovery(null, () => false, "replacement-db");
  expect(second.getAppliedSequence()).toBe(10);
  expect(second.classifyDomainEvent(11)).toBe("apply");
  // The second surface refreshes normally, rather than resetting the shared epoch again.
  expect(useStore.getState().projectCatalogGenerationByScope.local).toBe(generations.local + 2);
});

it.each(["epoch", "full snapshot"] as const)(
  "revokes old targeted reads on %s replacement",
  async (replacement) => {
    const pending = deferredProjectPage();
    const result = loadProjectById({
      api: { orchestration: { getStartupProjectCatalog: vi.fn(() => pending.promise) } },
      projectId: otherProjectId,
      getProject: () =>
        useStore.getState().projects.find((project) => project.id === otherProjectId),
      mergeProjectCatalogPage: useStore.getState().mergeProjectCatalogPage,
    });
    const rejected = expect(result).rejects.toThrow("superseded");
    if (replacement === "epoch") useStore.getState().resetProjectCatalogEpoch("replacement-db");
    else useStore.getState().syncServerReadModel(makeReadModel(makeReadModelThread({})));
    pending.resolve({
      ...emptyPage,
      projectionSequence: 100,
      projects: [
        {
          id: otherProjectId,
          title: "Late old metadata",
          providerRuntimeExecutionTargetId: "local",
          workspaceExecutionTargetId: "local",
          executionTargetId: "local",
          workspaceRoot: "/old-db",
          lastUsedAt: "2026-11-09T00:00:00.000Z",
          updatedAt: "2026-11-09T00:00:00.000Z",
          deletingAt: null,
          threadCount: 0,
          exceptionalThreadCount: 0,
          hasExceptionalThreads: false,
        },
      ],
    });
    await rejected;
    expect(useStore.getState().projects.some((project) => project.id === otherProjectId)).toBe(
      false,
    );
  },
);

it.each(["success", "failure"] as const)(
  "reopens a nonselected thread after epoch reset despite late hydration %s",
  async (outcome) => {
    const { recovery, api, orchestration } = setup();
    await recovery.runDeliveryBaselineRecovery(null, () => false, "old-db");
    const detail = await orchestration.getSelectedThreadDetail({ threadId: recentId });
    orchestration.getSelectedThreadDetail.mockClear();
    let resolveOld!: (value: GetSelectedThreadDetailResult) => void;
    let rejectOld!: (error: Error) => void;
    orchestration.getSelectedThreadDetail.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          resolveOld = resolve;
          rejectOld = reject;
        }),
    );
    const oldLoad = hydrateSelectedThread({ api, threadId: recentId });
    expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("loading");
    // Navigate to B while A is still loading, then recover B against the replacement database.
    await hydrateSelectedThread({ api, threadId: otherId });
    await recovery.runDeliveryBaselineRecovery(otherId, () => false, "replacement-db");
    expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("unloaded");
    expect(useStore.getState().threadHydrationById[otherId]?.status).toBe("complete");
    let resolveFresh!: (value: GetSelectedThreadDetailResult) => void;
    orchestration.getSelectedThreadDetail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFresh = resolve;
        }),
    );
    const freshLoad = hydrateSelectedThread({ api, threadId: recentId });
    expect(
      orchestration.getSelectedThreadDetail.mock.calls.filter(
        ([input]) => input.threadId === recentId,
      ),
    ).toHaveLength(2);
    // An obsolete success or failure must not complete/fail the new owner of A's hydration.
    if (outcome === "success") resolveOld({ ...detail, projectionSequence: 100 });
    else rejectOld(new Error("Old database disconnected"));
    await oldLoad;
    expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("loading");
    resolveFresh(detail);
    await freshLoad;
    expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("complete");
  },
);

it("does not cancel an in-flight hydration on same-epoch adoption", async () => {
  const { recovery, api, orchestration } = setup();
  await recovery.runDeliveryBaselineRecovery(null, () => false, "same-db");
  const detail = await orchestration.getSelectedThreadDetail({ threadId: recentId });
  let resolve!: (value: GetSelectedThreadDetailResult) => void;
  orchestration.getSelectedThreadDetail.mockImplementationOnce(
    () =>
      new Promise((complete) => {
        resolve = complete;
      }),
  );
  const loading = hydrateSelectedThread({ api, threadId: recentId });
  await recovery.runDeliveryBaselineRecovery(otherId, () => false, "same-db");
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("loading");
  resolve(detail);
  await loading;
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("complete");
});

it("full snapshots clear project freshness maps and replace high-sequence metadata", () => {
  const model = makeReadModel(makeReadModelThread({}));
  const id = model.projects[0]!.id;
  useStore.setState({
    latestProjectEventSequenceById: { [id]: 100 },
    deletedProjectSequenceById: { [id]: 100 },
    projectCatalogSequenceById: { [id]: 100 },
    pendingUnloadedProjectPatchById: { [id]: { sequence: 100, patch: { name: "Old patch" } } },
  });
  const generation = useStore.getState().projectCatalogGenerationByScope.local;
  useStore.getState().syncServerReadModel(model);
  expect(useStore.getState().projects[0]?.name).toBe("Project");
  expect(useStore.getState().projectCatalogGenerationByScope.local).toBe(generation + 1);
  expect(useStore.getState().latestProjectEventSequenceById).toEqual({});
  expect(useStore.getState().deletedProjectSequenceById).toEqual({});
  expect(useStore.getState().projectCatalogSequenceById).toEqual({});
  expect(useStore.getState().pendingUnloadedProjectPatchById).toEqual({});
});
