import {
  ProjectId,
  ThreadId,
  type GetProjectThreadSummariesResult,
  type GetSelectedThreadDetailResult,
  type GetStartupProjectCatalogResult,
  type NativeApi,
} from "@bigbud/contracts";
import type { GetSidebarThreadCatalogResult } from "@bigbud/contracts/orchestration/orchestration.catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../stores/main";
import { loadMoreProjectThreadSummaries, runBoundedBootstrap } from "./-__root.bounded-bootstrap";

const project1 = ProjectId.makeUnsafe("project-1");
const project2 = ProjectId.makeUnsafe("project-2");
const project3 = ProjectId.makeUnsafe("project-3");
const selectedThread = ThreadId.makeUnsafe("thread-selected");

function makeThreadSummary(id: ThreadId, projectId: ProjectId, pinnedAt: string | null = null) {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    purpose: "standard" as const,
    elevatorSummary: `Thread ${id}`,
    modelSelection: { provider: "codex" as const, model: "gpt-5.5" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    branch: null,
    worktreePath: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    latestUserMessageAt: "2026-07-30T00:00:00.000Z",
    pinnedAt,
    sessionStatus: null,
    providerName: null,
    activeTurnId: null,
    latestTurnState: null,
    isWatching: false,
    isWatched: false,
    isDelegated: false,
    isAwaitingApproval: false,
  };
}

function makeProject(id: ProjectId, title: string) {
  return {
    id,
    title,
    providerRuntimeExecutionTargetId: "ssh:provider",
    workspaceExecutionTargetId: "ssh:workspace",
    executionTargetId: "ssh:legacy",
    workspaceRoot: `/tmp/${id}`,
    lastUsedAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    deletingAt: null,
    threadCount: 0,
    exceptionalThreadCount: 0,
    hasExceptionalThreads: false,
  };
}

function makeApi() {
  const orchestration = {
    getSidebarThreadCatalog: vi.fn(
      async (): Promise<GetSidebarThreadCatalogResult> => ({
        projectionSequence: 10,
        threads: [],
        recentThreadIds: [],
        pinnedThreadIds: [],
      }),
    ),
    getStartupProjectCatalog: vi.fn(),
    getProjectThreadSummaries: vi.fn(
      async ({ projectId }) =>
        ({
          projectionSequence: 11,
          projectId,
          threads: [],
        }) satisfies GetProjectThreadSummariesResult,
    ),
    getSelectedThreadDetail: vi.fn(
      async () =>
        ({
          projectionSequence: 9,
          threadId: selectedThread,
          projectId: project1,
          activityTurnId: null,
          messages: [],
          messageWindow: {
            order: "newest-first",
            requestedCursor: null,
            newestCursor: null,
            oldestCursor: null,
            nextCursor: null,
            hasOlder: false,
          },
          activities: [],
          activitiesTruncated: false,
          pendingApprovals: [],
          pendingApprovalsTruncated: false,
          pendingUserInputs: [],
          pendingUserInputsTruncated: false,
          activePlan: null,
          activeTasks: [],
          activeTasksTruncated: false,
          checkpoints: [],
          checkpointsTruncated: false,
        }) satisfies GetSelectedThreadDetailResult,
    ),
  };
  return { api: { orchestration } as unknown as NativeApi, orchestration };
}

beforeEach(() => {
  useStore.setState({
    projects: [],
    threads: [],
    sidebarThreadsById: {},
    threadIdsByProjectId: {},
    threadSummaryCursorByProjectId: {},
    threadHydrationById: {},
    sidebarRecentThreadIds: [],
    sidebarPinnedThreadIds: [],
    bootstrapComplete: false,
  });
});

describe("bounded project catalog bootstrap", () => {
  it("continues the project catalog without eagerly loading later project threads", async () => {
    const { api, orchestration } = makeApi();
    const cursor = { lastUsedAt: "2026-07-30T00:00:00.000Z", projectId: project1 };
    orchestration.getStartupProjectCatalog
      .mockResolvedValueOnce({
        projectionSequence: 10,
        projects: [makeProject(project1, "Project 1")],
        nextCursor: cursor,
      } satisfies GetStartupProjectCatalogResult)
      .mockResolvedValueOnce({
        projectionSequence: 12,
        projects: [makeProject(project2, "Project 2")],
      } satisfies GetStartupProjectCatalogResult);

    await runBoundedBootstrap({ api, selectedThreadId: null, disposed: () => false });

    expect(orchestration.getStartupProjectCatalog.mock.calls).toEqual([
      [{ limit: 2 }],
      [{ limit: 20, cursor }],
    ]);
    expect(orchestration.getProjectThreadSummaries).toHaveBeenCalledTimes(1);
    expect(useStore.getState().projects.map((project) => project.id)).toEqual([project1, project2]);
    expect(useStore.getState().projects[1]).toMatchObject({
      workspaceExecutionTargetId: "ssh:workspace",
    });
    expect(useStore.getState().threadSummaryCursorByProjectId?.[project2]).toBeUndefined();
  });

  it("loads the first thread summary page for a catalog project that was initially deferred", async () => {
    const { api, orchestration } = makeApi();

    await loadMoreProjectThreadSummaries({ api, projectId: project2 });

    expect(orchestration.getProjectThreadSummaries).toHaveBeenCalledWith({
      projectId: project2,
      limit: 5,
    });
  });

  it("does not duplicate a prioritized project from a later catalog page", async () => {
    const { api, orchestration } = makeApi();
    const cursor = { lastUsedAt: "2026-07-30T00:00:00.000Z", projectId: project2 };
    orchestration.getStartupProjectCatalog
      .mockResolvedValueOnce({
        projectionSequence: 10,
        projects: [makeProject(project1, "Prioritized"), makeProject(project2, "Recent")],
        nextCursor: cursor,
      } satisfies GetStartupProjectCatalogResult)
      .mockResolvedValueOnce({
        projectionSequence: 12,
        projects: [makeProject(project3, "Older"), makeProject(project1, "Prioritized")],
      } satisfies GetStartupProjectCatalogResult);

    await runBoundedBootstrap({ api, selectedThreadId: selectedThread, disposed: () => false });

    expect(useStore.getState().projects.map((project) => project.id)).toEqual([
      project1,
      project2,
      project3,
    ]);
  });

  it("restores recent chats outside sampled projects and global pins outside project pages", async () => {
    const { api, orchestration } = makeApi();
    const recentChat = ThreadId.makeUnsafe("persisted-chat");
    const oldPin = ThreadId.makeUnsafe("old-project-pin");
    orchestration.getStartupProjectCatalog.mockResolvedValue({
      projectionSequence: 10,
      projects: [makeProject(project1, "Project 1"), makeProject(project2, "Project 2")],
    } satisfies GetStartupProjectCatalogResult);
    orchestration.getSidebarThreadCatalog.mockResolvedValue({
      projectionSequence: 10,
      threads: [
        makeThreadSummary(recentChat, ProjectId.makeUnsafe("__chats__")),
        makeThreadSummary(oldPin, project3, "2026-07-29T00:00:00.000Z"),
      ],
      recentThreadIds: [recentChat],
      pinnedThreadIds: [oldPin],
    });

    await runBoundedBootstrap({ api, selectedThreadId: null, disposed: () => false });

    expect(useStore.getState().sidebarRecentThreadIds).toEqual([recentChat]);
    expect(useStore.getState().sidebarPinnedThreadIds).toEqual([oldPin]);
    expect(useStore.getState().sidebarThreadsById).toHaveProperty(recentChat);
    expect(useStore.getState().sidebarThreadsById).toHaveProperty(oldPin);
  });

  it("preserves hydrated detail and unrelated summaries during replay-gap reconciliation", async () => {
    const { api, orchestration } = makeApi();
    const unrelated = ThreadId.makeUnsafe("already-hydrated");
    const message = {
      id: "message-existing",
      role: "user" as const,
      text: "keep me",
      streaming: false,
      turnId: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const existing = makeThreadSummary(unrelated, project3);
    orchestration.getStartupProjectCatalog.mockResolvedValue({
      projectionSequence: 10,
      projects: [makeProject(project1, "Project 1")],
    } satisfies GetStartupProjectCatalogResult);
    orchestration.getSidebarThreadCatalog.mockResolvedValue({
      projectionSequence: 10,
      threads: [existing],
      recentThreadIds: [],
      pinnedThreadIds: [],
    });
    await runBoundedBootstrap({ api, selectedThreadId: null, disposed: () => false });
    const hydrated = useStore.getState().threads.find((thread) => thread.id === unrelated)!;
    useStore.setState({
      threads: [{ ...hydrated, messages: [message as never] }],
      sidebarThreadsById: {
        ...useStore.getState().sidebarThreadsById,
        stale: {
          ...useStore.getState().sidebarThreadsById[unrelated]!,
          id: ThreadId.makeUnsafe("stale"),
        },
      },
    });

    await runBoundedBootstrap({ api, selectedThreadId: null, disposed: () => false });

    expect(useStore.getState().threads[0]?.messages).toEqual([message]);
    expect(useStore.getState().sidebarThreadsById).toHaveProperty("stale");
    expect(useStore.getState().threads.filter((thread) => thread.id === unrelated)).toHaveLength(1);
  });

  it("leaves prior state recoverable when the sidebar catalog request fails", async () => {
    const { api, orchestration } = makeApi();
    useStore.setState({
      sidebarRecentThreadIds: [selectedThread],
      sidebarPinnedThreadIds: [selectedThread],
    });
    orchestration.getSidebarThreadCatalog.mockRejectedValueOnce(new Error("catalog unavailable"));

    await expect(
      runBoundedBootstrap({ api, selectedThreadId: null, disposed: () => false }),
    ).rejects.toThrow("catalog unavailable");

    expect(useStore.getState().sidebarRecentThreadIds).toEqual([selectedThread]);
    expect(useStore.getState().sidebarPinnedThreadIds).toEqual([selectedThread]);
    orchestration.getSidebarThreadCatalog.mockResolvedValueOnce({
      projectionSequence: 10,
      threads: [],
      recentThreadIds: [],
      pinnedThreadIds: [],
    });
  });

  it("restores a created and pinned thread in a fresh store, then reflects persisted unpin", async () => {
    const { api, orchestration } = makeApi();
    const persisted = ThreadId.makeUnsafe("created-before-restart");
    orchestration.getStartupProjectCatalog.mockResolvedValue({
      projectionSequence: 10,
      projects: [],
    } satisfies GetStartupProjectCatalogResult);
    orchestration.getSidebarThreadCatalog.mockResolvedValue({
      projectionSequence: 10,
      threads: [
        makeThreadSummary(persisted, ProjectId.makeUnsafe("__chats__"), "2026-07-30T00:00:00.000Z"),
      ],
      recentThreadIds: [persisted],
      pinnedThreadIds: [persisted],
    });

    await runBoundedBootstrap({ api, selectedThreadId: null, disposed: () => false });
    expect(useStore.getState().sidebarRecentThreadIds).toEqual([persisted]);
    expect(useStore.getState().sidebarPinnedThreadIds).toEqual([persisted]);

    useStore.setState({
      projects: [],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      threadSummaryCursorByProjectId: {},
      threadHydrationById: {},
      sidebarRecentThreadIds: [],
      sidebarPinnedThreadIds: [],
      bootstrapComplete: false,
    });
    await runBoundedBootstrap({ api, selectedThreadId: null, disposed: () => false });
    expect(useStore.getState().sidebarRecentThreadIds).toEqual([persisted]);
    expect(useStore.getState().sidebarPinnedThreadIds).toEqual([persisted]);

    orchestration.getSidebarThreadCatalog.mockResolvedValue({
      projectionSequence: 11,
      threads: [makeThreadSummary(persisted, ProjectId.makeUnsafe("__chats__"))],
      recentThreadIds: [persisted],
      pinnedThreadIds: [],
    });
    await runBoundedBootstrap({ api, selectedThreadId: null, disposed: () => false });
    expect(useStore.getState().sidebarPinnedThreadIds).toEqual([]);
  });
});
