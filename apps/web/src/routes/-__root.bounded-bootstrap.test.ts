import {
  ProjectId,
  MessageId,
  ThreadId,
  type GetProjectThreadSummariesResult,
  type GetSelectedThreadDetailResult,
  type GetStartupProjectCatalogResult,
  type NativeApi,
  type OrchestrationReplayEventsResult,
} from "@bigbud/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  setThreadHydrationEventApplier,
  threadHydrationEventBuffer,
} from "../logic/orchestration/thread-hydration-events.logic";
import { useStore } from "../stores/main";
import { makeEvent } from "../stores/main/main.store.test.helpers";
import { createEventRouterRecovery } from "./-__root.recovery";
import {
  hydrateSelectedThread,
  loadMoreProjectThreadSummaries,
  loadOlderThreadMessages,
  runBoundedBootstrap,
} from "./-__root.bounded-bootstrap";

const project1 = ProjectId.makeUnsafe("project-1");
const project2 = ProjectId.makeUnsafe("project-2");
const selectedThread = ThreadId.makeUnsafe("thread-selected");

function makeCatalog(): GetStartupProjectCatalogResult {
  return {
    projectionSequence: 10,
    projects: [project2, project1].map((id, index) => ({
      id,
      title: `Project ${index + 1}`,
      providerRuntimeExecutionTargetId: "ssh:provider",
      workspaceExecutionTargetId: "ssh:workspace",
      executionTargetId: "ssh:legacy",
      workspaceRoot: `/tmp/project-${index + 1}`,
      lastUsedAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      deletingAt: null,
      threadCount: 10,
      exceptionalThreadCount: 0,
      hasExceptionalThreads: false,
    })),
  };
}

function makeThreadPage(projectId: typeof project1): GetProjectThreadSummariesResult {
  const threadId = projectId === project2 ? selectedThread : ThreadId.makeUnsafe("thread-other");
  return {
    projectionSequence: 11,
    projectId,
    threads: [
      {
        id: threadId,
        projectId,
        title: "Thread",
        purpose: "standard",
        elevatorSummary: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5.5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        providerRuntimeExecutionTargetId: "ssh:provider",
        workspaceExecutionTargetId: "ssh:workspace",
        executionTargetId: "ssh:legacy",
        branch: "feature/remote",
        worktreePath: "/worktrees/remote",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
        latestUserMessageAt: "2026-07-29T00:00:00.000Z",
        pinnedAt: null,
        sessionStatus: null,
        providerName: null,
        activeTurnId: null,
        latestTurnState: null,
        isWatching: false,
        isWatched: false,
        isDelegated: false,
        isAwaitingApproval: false,
      },
    ],
  };
}

function makeDetail(): GetSelectedThreadDetailResult {
  return {
    projectionSequence: 9,
    threadId: selectedThread,
    projectId: project2,
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
  };
}

function makeApi() {
  const orchestration = {
    getSidebarThreadCatalog: vi.fn(async () => ({
      projectionSequence: 10,
      threads: [],
      recentThreadIds: [],
      pinnedThreadIds: [],
    })),
    getStartupProjectCatalog: vi.fn(async () => makeCatalog()),
    getProjectThreadSummaries: vi.fn(async ({ projectId }) => makeThreadPage(projectId)),
    getSelectedThreadDetail: vi.fn(async () => makeDetail()),
    getSnapshot: vi.fn(),
    replayEvents: vi.fn(
      async (fromSequenceExclusive: number): Promise<OrchestrationReplayEventsResult> => ({
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence: fromSequenceExclusive,
        availability: "available",
        complete: true,
        events: [],
      }),
    ),
  };
  return { api: { orchestration } as unknown as NativeApi, orchestration };
}

function makeRecovery(api: NativeApi, applyOrchestrationEvents = vi.fn()) {
  return createEventRouterRecovery({
    api,
    queryClient: new QueryClient(),
    clearAllThinkingDeltas: vi.fn(),
    reconcileThinkingActivities: vi.fn(),
    applyOrchestrationEvents,
    syncProjects: vi.fn(),
    syncThreads: vi.fn(),
    clearThreadUi: vi.fn(),
    removeFromSelection: vi.fn(),
    removeTerminalState: vi.fn(),
    removeOrphanedTerminalStates: vi.fn(),
    applyTerminalEvent: vi.fn(),
  });
}

beforeEach(() => {
  threadHydrationEventBuffer.clear();
  setThreadHydrationEventApplier(null);
  useStore.setState({
    projects: [],
    threads: [],
    sidebarThreadsById: {},
    threadIdsByProjectId: {},
    threadSummaryCursorByProjectId: {},
    sidebarRecentThreadIds: [],
    sidebarPinnedThreadIds: [],
    threadHydrationById: {},
    bootstrapComplete: false,
  });
});

describe("bounded orchestration bootstrap", () => {
  it("loads only the selected project summary page and hydrates its selected thread", async () => {
    const { api, orchestration } = makeApi();

    await runBoundedBootstrap({ api, selectedThreadId: selectedThread, disposed: () => false });

    expect(orchestration.getSelectedThreadDetail).toHaveBeenCalledTimes(1);
    expect(orchestration.getSidebarThreadCatalog).toHaveBeenCalledTimes(1);
    expect(orchestration.getSelectedThreadDetail).toHaveBeenCalledWith({
      threadId: selectedThread,
    });
    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith({
      limit: 2,
      priorityProjectId: project2,
    });
    expect(orchestration.getProjectThreadSummaries).toHaveBeenCalledTimes(1);
    expect(orchestration.getProjectThreadSummaries.mock.calls).toEqual([
      [{ projectId: project2, limit: 5, priorityThreadId: selectedThread }],
    ]);
    expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    expect(useStore.getState().threadHydrationById[selectedThread]).toEqual({
      status: "complete",
    });
    expect(useStore.getState().threads[0]).toMatchObject({
      providerRuntimeExecutionTargetId: "ssh:provider",
      workspaceExecutionTargetId: "ssh:workspace",
      executionTargetId: "ssh:legacy",
      branch: "feature/remote",
      worktreePath: "/worktrees/remote",
    });
    expect(useStore.getState().sidebarThreadsById[selectedThread]).toMatchObject({
      providerRuntimeExecutionTargetId: "ssh:provider",
      workspaceExecutionTargetId: "ssh:workspace",
      executionTargetId: "ssh:legacy",
      branch: "feature/remote",
      worktreePath: "/worktrees/remote",
    });
  });

  it("tracks loadingOlder and completion for an older message fetch", async () => {
    const { api, orchestration } = makeApi();
    await runBoundedBootstrap({ api, selectedThreadId: selectedThread, disposed: () => false });
    useStore.getState().setThreadHydration(selectedThread, {
      status: "loaded",
      nextCursor: {
        createdAt: "2026-07-29T00:00:00.000Z",
        messageId: MessageId.makeUnsafe("message-1"),
      },
    });
    orchestration.getSelectedThreadDetail.mockResolvedValueOnce(makeDetail());

    const loading = loadOlderThreadMessages({ api, threadId: selectedThread });
    expect(useStore.getState().threadHydrationById[selectedThread]?.status).toBe("loadingOlder");
    await loading;

    expect(useStore.getState().threadHydrationById[selectedThread]).toEqual({
      status: "complete",
    });
  });

  it("appends the next bounded thread summary page for a project", async () => {
    const { api, orchestration } = makeApi();
    await runBoundedBootstrap({ api, selectedThreadId: selectedThread, disposed: () => false });
    const cursor = {
      updatedAt: "2026-07-29T00:00:00.000Z",
      threadId: ThreadId.makeUnsafe("thread-cursor"),
    };
    const nextThread = ThreadId.makeUnsafe("thread-next");
    useStore.setState({
      threadSummaryCursorByProjectId: { [project2]: cursor },
    });
    const nextPage: GetProjectThreadSummariesResult = {
      ...makeThreadPage(project2),
      threads: [
        {
          ...makeThreadPage(project2).threads[0]!,
          id: nextThread,
          title: "Next thread",
        },
      ],
    };
    orchestration.getProjectThreadSummaries.mockResolvedValueOnce(nextPage);

    await loadMoreProjectThreadSummaries({ api, projectId: project2 });

    expect(orchestration.getProjectThreadSummaries).toHaveBeenLastCalledWith({
      projectId: project2,
      limit: 5,
      cursor,
    });
    expect(useStore.getState().threadIdsByProjectId[project2]).toEqual([
      selectedThread,
      nextThread,
    ]);
  });

  it("installs detail before replaying a newer buffered thread event", async () => {
    const { api, orchestration } = makeApi();
    await runBoundedBootstrap({ api, selectedThreadId: selectedThread, disposed: () => false });
    useStore.getState().setThreadHydration(selectedThread, { status: "unloaded" });
    let resolveDetail!: (detail: GetSelectedThreadDetailResult) => void;
    orchestration.getSelectedThreadDetail.mockImplementationOnce(
      () => new Promise((resolve) => (resolveDetail = resolve)),
    );

    const loading = hydrateSelectedThread({ api, threadId: selectedThread });
    threadHydrationEventBuffer.bufferEvent(
      makeEvent(
        "thread.meta-updated",
        {
          threadId: selectedThread,
          title: "Newer event title",
          updatedAt: "2026-07-30T00:00:01.000Z",
        },
        { sequence: 12 },
      ),
    );
    resolveDetail({ ...makeDetail(), projectionSequence: 11 });
    await loading;

    expect(useStore.getState().threads.find((thread) => thread.id === selectedThread)?.title).toBe(
      "Newer event title",
    );
  });

  it("does not replay an event covered by the detail projection", async () => {
    const { api, orchestration } = makeApi();
    await runBoundedBootstrap({ api, selectedThreadId: selectedThread, disposed: () => false });
    useStore.getState().setThreadHydration(selectedThread, { status: "unloaded" });
    let resolveDetail!: (detail: GetSelectedThreadDetailResult) => void;
    orchestration.getSelectedThreadDetail.mockImplementationOnce(
      () => new Promise((resolve) => (resolveDetail = resolve)),
    );

    const loading = hydrateSelectedThread({ api, threadId: selectedThread });
    threadHydrationEventBuffer.bufferEvent(
      makeEvent(
        "thread.meta-updated",
        {
          threadId: selectedThread,
          title: "Covered event title",
          updatedAt: "2026-07-30T00:00:01.000Z",
        },
        { sequence: 12 },
      ),
    );
    resolveDetail({ ...makeDetail(), projectionSequence: 12 });
    await loading;

    expect(useStore.getState().threads.find((thread) => thread.id === selectedThread)?.title).toBe(
      "Thread",
    );
  });

  it("uses targeted bounded recovery when reconnect replay is unavailable", async () => {
    const { api, orchestration } = makeApi();
    orchestration.replayEvents.mockResolvedValueOnce({
      requestedFromSequenceExclusive: 9,
      retainedFromSequenceExclusive: 12,
      earliestAvailableSequence: 13,
      latestSequence: 15,
      availability: "gap",
      complete: false,
      events: [],
    });
    const recovery = makeRecovery(api);

    await recovery.runBoundedRecovery("bootstrap", selectedThread, () => false);
    await recovery.runReplayRecovery(
      "resubscribe",
      () => false,
      () => {
        void recovery.runBoundedRecovery("replay-failed", selectedThread, () => false);
      },
    );
    await vi.waitFor(() => {
      expect(orchestration.getProjectThreadSummaries).toHaveBeenCalledTimes(2);
    });

    expect(orchestration.getSelectedThreadDetail).toHaveBeenCalledTimes(2);
    expect(orchestration.getSidebarThreadCatalog).toHaveBeenCalledTimes(2);
    expect(orchestration.getProjectThreadSummaries).toHaveBeenCalledTimes(2);
    expect(orchestration.getSnapshot).not.toHaveBeenCalled();
  });

  it("accepts empty-complete and nonempty-contiguous typed replay results", async () => {
    const { api, orchestration } = makeApi();
    const applyOrchestrationEvents = vi.fn();
    const recovery = makeRecovery(api, applyOrchestrationEvents);
    await recovery.runBoundedRecovery("bootstrap", selectedThread, () => false);
    const fallback = vi.fn();

    await recovery.runReplayRecovery("resubscribe", () => false, fallback);
    expect(fallback).not.toHaveBeenCalled();

    const event = makeEvent(
      "thread.meta-updated",
      {
        threadId: selectedThread,
        title: "Replayed title",
        updatedAt: "2026-07-30T00:00:01.000Z",
      },
      { sequence: 10 },
    );
    orchestration.replayEvents.mockResolvedValueOnce({
      requestedFromSequenceExclusive: 9,
      retainedFromSequenceExclusive: 0,
      earliestAvailableSequence: 1,
      latestSequence: 10,
      availability: "available",
      complete: true,
      events: [event],
    });
    const secondRecovery = makeRecovery(api, applyOrchestrationEvents);
    await secondRecovery.runBoundedRecovery("bootstrap", selectedThread, () => false);
    await secondRecovery.runReplayRecovery("resubscribe", () => false, fallback);

    expect(applyOrchestrationEvents).toHaveBeenCalledWith([event]);
    expect(fallback).not.toHaveBeenCalled();
  });
});
