import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { syncSidebarCatalog } from "./helpers.lazy.store";
import type { AppState } from "./main.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

const projectId = ProjectId.makeUnsafe("project-1");
const threadId = ThreadId.makeUnsafe("thread-1");

function stateWithActiveCount(activeThreadCount: number): AppState {
  const state = makeState(makeThread({ id: threadId, projectId }));
  return {
    ...state,
    projects: [{ ...state.projects[0]!, activeThreadCount }],
  };
}

describe("active project thread count events", () => {
  it("tracks archive, restore, deletion request, failure recovery, and deletion transitions", () => {
    let state = stateWithActiveCount(1);

    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.archived", {
        threadId,
        archivedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    expect(state.projects[0]?.activeThreadCount).toBe(0);

    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.unarchived", {
        threadId,
        updatedAt: "2026-08-01T00:01:00.000Z",
      }),
    );
    expect(state.projects[0]?.activeThreadCount).toBe(1);

    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.deletion-requested", {
        threadId,
        deletingAt: "2026-08-01T00:02:00.000Z",
      }),
    );
    expect(state.projects[0]?.activeThreadCount).toBe(0);

    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.deletion-failed", {
        threadId,
        updatedAt: "2026-08-01T00:03:00.000Z",
      }),
    );
    expect(state.projects[0]?.activeThreadCount).toBe(1);

    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId,
        deletedAt: "2026-08-01T00:04:00.000Z",
      }),
    );
    expect(state.projects[0]?.activeThreadCount).toBe(0);
  });

  it("increments standard creates without counting side chats", () => {
    let state = stateWithActiveCount(1);
    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId: ThreadId.makeUnsafe("created-standard"),
        projectId,
        title: "Created standard",
        purpose: "standard",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    expect(state.projects[0]?.activeThreadCount).toBe(2);

    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId: ThreadId.makeUnsafe("created-side-chat"),
        projectId,
        title: "Created side chat",
        purpose: "side-chat",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    expect(state.projects[0]?.activeThreadCount).toBe(2);
  });

  it("replaces a locally stale count during an authoritative sidebar catalog refresh", () => {
    const state = stateWithActiveCount(5);
    const next = syncSidebarCatalog(state, {
      projectionSequence: 12,
      threads: [],
      recentThreadIds: [],
      pinnedThreadIds: [],
      projectThreadCounts: [{ projectId, threadCount: 4 }],
    });

    expect(next.projects[0]?.activeThreadCount).toBe(4);
  });
});
