import { ProjectId, ThreadId, type NativeApi } from "@bigbud/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { createEventRouterRecovery } from "./-__root.recovery";
import { useStore } from "../stores/main";
import { makeEvent } from "../stores/main/main.store.test.helpers";

const pinnedThread = ThreadId.makeUnsafe("replayed-pinned-thread");

function makeSummary() {
  return {
    id: pinnedThread,
    projectId: ProjectId.makeUnsafe("old-project"),
    title: "Replayed pin",
    purpose: "standard" as const,
    elevatorSummary: "Replayed pin",
    modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    branch: null,
    worktreePath: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    latestUserMessageAt: null,
    pinnedAt: "2026-07-02T00:00:00.000Z",
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

function makeApi() {
  const replayEvent = makeEvent(
    "thread.pinned",
    {
      threadId: pinnedThread,
      pinnedAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    },
    { sequence: 11 },
  );
  const orchestration = {
    getSidebarThreadCatalog: vi
      .fn()
      .mockResolvedValueOnce({
        projectionSequence: 10,
        threads: [],
        recentThreadIds: [],
        pinnedThreadIds: [],
      })
      .mockResolvedValueOnce({
        projectionSequence: 11,
        threads: [makeSummary()],
        recentThreadIds: [],
        pinnedThreadIds: [pinnedThread],
      }),
    getStartupProjectCatalog: vi.fn(async () => ({ projectionSequence: 10, projects: [] })),
    getProjectThreadSummaries: vi.fn(),
    getSelectedThreadDetail: vi.fn(),
    replayEvents: vi.fn(async () => ({
      requestedFromSequenceExclusive: 10,
      retainedFromSequenceExclusive: 0,
      earliestAvailableSequence: 1,
      latestSequence: 11,
      availability: "available" as const,
      complete: true,
      events: [replayEvent],
    })),
  };
  return { api: { orchestration } as unknown as NativeApi, orchestration };
}

function makeRecovery(api: NativeApi) {
  return createEventRouterRecovery({
    api,
    queryClient: new QueryClient(),
    clearAllThinkingDeltas: vi.fn(),
    reconcileThinkingActivities: vi.fn(),
    applyOrchestrationEvents: vi.fn(),
    syncProjects: vi.fn(),
    syncThreads: vi.fn(),
    clearThreadUi: vi.fn(),
    removeFromSelection: vi.fn(),
    removeTerminalState: vi.fn(),
    removeOrphanedTerminalStates: vi.fn(),
    applyTerminalEvent: vi.fn(),
  });
}

describe("sidebar catalog replay reconciliation", () => {
  it("hydrates a replayed pin that was absent from the bounded bootstrap catalog", async () => {
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
    const { api, orchestration } = makeApi();
    const recovery = makeRecovery(api);

    await recovery.runBoundedRecovery("bootstrap", null, () => false);
    await recovery.runReplayRecovery("sequence-gap", () => false, vi.fn());

    expect(orchestration.getSidebarThreadCatalog).toHaveBeenCalledTimes(2);
    expect(useStore.getState().sidebarPinnedThreadIds).toEqual([pinnedThread]);
    expect(useStore.getState().sidebarThreadsById[pinnedThread]?.title).toBe("Replayed pin");
  });
});
