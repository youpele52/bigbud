import { ThreadId } from "@bigbud/contracts";
import type { ThreadSummary } from "@bigbud/contracts/orchestration/orchestration.catalog";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { syncSidebarCatalog } from "./helpers.lazy.store";
import { buildSidebarThreadSummary } from "./mappers.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

function makeCatalogSummary(thread: ReturnType<typeof makeThread>): ThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    purpose: thread.purpose ?? "standard",
    elevatorSummary: thread.elevatorSummary ?? thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    providerRuntimeExecutionTargetId: thread.providerRuntimeExecutionTargetId ?? "local",
    workspaceExecutionTargetId: thread.workspaceExecutionTargetId ?? "local",
    executionTargetId: thread.executionTargetId ?? "local",
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt ?? thread.createdAt,
    latestUserMessageAt: null,
    pinnedAt: thread.pinnedAt ?? null,
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

describe("thread deletion state", () => {
  it("removes deleted thread descendants from state and sidebar caches", () => {
    const rootThread = makeThread({ id: ThreadId.makeUnsafe("thread-root") });
    const descendantThread = makeThread({ id: ThreadId.makeUnsafe("thread-descendant") });
    const retainedThread = makeThread({ id: ThreadId.makeUnsafe("thread-retained") });
    const state = {
      ...makeState(rootThread),
      threads: [rootThread, descendantThread, retainedThread],
      sidebarThreadsById: {
        [rootThread.id]: buildSidebarThreadSummary(rootThread),
        [descendantThread.id]: buildSidebarThreadSummary(descendantThread),
        [retainedThread.id]: buildSidebarThreadSummary(retainedThread),
      },
      threadIdsByProjectId: {
        [rootThread.projectId]: [rootThread.id, descendantThread.id, retainedThread.id],
      },
      threadHydrationById: {
        [rootThread.id]: { status: "complete" as const },
        [descendantThread.id]: { status: "complete" as const },
        [retainedThread.id]: { status: "complete" as const },
      },
      sidebarRecentThreadIds: [rootThread.id, descendantThread.id, retainedThread.id],
      sidebarPinnedThreadIds: [descendantThread.id, retainedThread.id],
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: rootThread.id,
        threadIds: [rootThread.id, descendantThread.id],
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toEqual([retainedThread]);
    expect(next.sidebarThreadsById).toEqual({
      [retainedThread.id]: buildSidebarThreadSummary(retainedThread),
    });
    expect(next.threadIdsByProjectId[rootThread.projectId]).toEqual([retainedThread.id]);
    expect(next.threadHydrationById).toEqual({ [retainedThread.id]: { status: "complete" } });
    expect(next.sidebarRecentThreadIds).toEqual([retainedThread.id]);
    expect(next.sidebarPinnedThreadIds).toEqual([retainedThread.id]);
  });

  it("keeps sidebar membership while deleting so abort can restore the thread", () => {
    const thread = makeThread({ id: ThreadId.makeUnsafe("thread-deleting") });
    const state = {
      ...makeState(thread),
      sidebarThreadsById: { [thread.id]: buildSidebarThreadSummary(thread) },
      sidebarRecentThreadIds: [thread.id],
      sidebarPinnedThreadIds: [thread.id],
    };

    const requested = applyOrchestrationEvent(
      state,
      makeEvent("thread.deletion-requested", {
        threadId: thread.id,
        deletingAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    expect(requested.sidebarRecentThreadIds).toEqual([thread.id]);
    expect(requested.sidebarPinnedThreadIds).toEqual([thread.id]);
    expect(requested.threads[0]?.deletingAt).toBe("2026-02-27T00:00:01.000Z");

    const aborted = applyOrchestrationEvent(
      requested,
      makeEvent("thread.deletion-failed", {
        threadId: thread.id,
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );
    expect(aborted.sidebarRecentThreadIds).toEqual([thread.id]);
    expect(aborted.sidebarPinnedThreadIds).toEqual([thread.id]);
    expect(aborted.threads[0]?.deletingAt).toBeNull();
  });

  it("keeps deleting membership when a catalog refresh omits the in-flight thread", () => {
    const thread = makeThread({
      id: ThreadId.makeUnsafe("thread-deleting"),
      deletingAt: "2026-02-27T00:00:01.000Z",
    });
    const retained = makeThread({ id: ThreadId.makeUnsafe("thread-retained") });
    const state = {
      ...makeState(thread),
      threads: [thread, retained],
      sidebarThreadsById: {
        [thread.id]: buildSidebarThreadSummary(thread),
        [retained.id]: buildSidebarThreadSummary(retained),
      },
      sidebarRecentThreadIds: [thread.id, retained.id],
      sidebarPinnedThreadIds: [thread.id],
    };

    const next = syncSidebarCatalog(state, {
      projectionSequence: 12,
      threads: [makeCatalogSummary(retained)],
      recentThreadIds: [retained.id],
      pinnedThreadIds: [],
    });

    expect(next.sidebarRecentThreadIds).toEqual([thread.id, retained.id]);
    expect(next.sidebarPinnedThreadIds).toEqual([thread.id]);
  });
});
