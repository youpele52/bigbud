import {
  ProjectId,
  ThreadId,
  type GetProjectThreadSummariesResult,
  type GetSelectedThreadDetailResult,
  type GetStartupProjectCatalogResult,
  type NativeApi,
} from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../stores/main";
import { loadMoreProjectThreadSummaries, runBoundedBootstrap } from "./-__root.bounded-bootstrap";

const project1 = ProjectId.makeUnsafe("project-1");
const project2 = ProjectId.makeUnsafe("project-2");
const project3 = ProjectId.makeUnsafe("project-3");
const selectedThread = ThreadId.makeUnsafe("thread-selected");

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
});
