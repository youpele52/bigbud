import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant";
import { FAVORITE_THREAD_LIMIT } from "@bigbud/contracts/constants/settings.constant";
import { SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS } from "@bigbud/contracts/orchestration/orchestration.catalog";
import type { ThreadSummary } from "@bigbud/contracts/orchestration/orchestration.catalog";
import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { syncSidebarCatalog as reconcileSidebarCatalog } from "./helpers.lazy.store";
import { buildSidebarThreadSummary } from "./mappers.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

function makeSummary(
  id: ThreadId,
  projectId: ProjectId,
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    purpose: "standard",
    elevatorSummary: `Summary ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    branch: null,
    worktreePath: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    latestUserMessageAt: null,
    pinnedAt: null,
    sessionStatus: null,
    providerName: null,
    activeTurnId: null,
    latestTurnState: null,
    isWatching: false,
    isWatched: false,
    isDelegated: false,
    isAwaitingApproval: false,
    ...overrides,
  };
}

describe("bounded sidebar membership", () => {
  it("bounds chat creates and user-message promotions", () => {
    const existing = makeThread({
      id: ThreadId.makeUnsafe("existing"),
      projectId: BUILT_IN_CHATS_PROJECT_ID,
    });
    const state = {
      ...makeState(existing),
      sidebarThreadsById: { [existing.id]: buildSidebarThreadSummary(existing) },
      sidebarRecentThreadIds: Array.from(
        { length: SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS },
        (_, index) => ThreadId.makeUnsafe(`chat-${index}`),
      ),
    };
    const createdId = ThreadId.makeUnsafe("new-chat");
    const created = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId: createdId,
        projectId: BUILT_IN_CHATS_PROJECT_ID,
        title: "New chat",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      }),
    );

    expect(created.sidebarRecentThreadIds).toHaveLength(SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS);
    expect(created.sidebarRecentThreadIds[0]).toBe(createdId);

    const promoted = applyOrchestrationEvent(
      created,
      makeEvent("thread.message-sent", {
        threadId: existing.id,
        messageId: "message-new" as never,
        role: "user",
        text: "new request",
        turnId: null,
        streaming: false,
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:00:00.000Z",
      }),
    );

    expect(promoted.sidebarRecentThreadIds).toHaveLength(SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS);
    expect(promoted.sidebarRecentThreadIds[0]).toBe(existing.id);
  });

  it("does not add membership for unknown or restored threads before catalog reconciliation", () => {
    const thread = makeThread({
      id: ThreadId.makeUnsafe("archived-thread"),
      projectId: BUILT_IN_CHATS_PROJECT_ID,
      archivedAt: "2026-07-01T00:00:00.000Z",
      deletingAt: "2026-07-01T00:00:00.000Z",
    });
    const state = {
      ...makeState(thread),
      sidebarThreadsById: { [thread.id]: buildSidebarThreadSummary(thread) },
      sidebarRecentThreadIds: [thread.id],
      sidebarPinnedThreadIds: [thread.id],
    };

    const archived = applyOrchestrationEvent(
      state,
      makeEvent("thread.archived", {
        threadId: thread.id,
        archivedAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      }),
    );
    expect(archived.sidebarRecentThreadIds).toEqual([]);
    expect(archived.sidebarPinnedThreadIds).toEqual([]);

    const restored = applyOrchestrationEvent(
      archived,
      makeEvent("thread.unarchived", {
        threadId: thread.id,
        updatedAt: "2026-07-03T00:00:00.000Z",
      }),
    );
    expect(restored.sidebarRecentThreadIds).toEqual([]);
    expect(restored.sidebarPinnedThreadIds).toEqual([]);

    const deletionFailed = applyOrchestrationEvent(
      restored,
      makeEvent("thread.deletion-failed", {
        threadId: thread.id,
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    );
    expect(deletionFailed.sidebarRecentThreadIds).toEqual([]);
    expect(deletionFailed.sidebarPinnedThreadIds).toEqual([]);

    const unknownPin = applyOrchestrationEvent(
      deletionFailed,
      makeEvent("thread.pinned", {
        threadId: ThreadId.makeUnsafe("not-loaded"),
        pinnedAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    );
    expect(unknownPin.sidebarPinnedThreadIds).toEqual([]);

    const deleted = applyOrchestrationEvent(
      {
        ...deletionFailed,
        sidebarRecentThreadIds: [thread.id],
        sidebarPinnedThreadIds: [thread.id],
      },
      makeEvent("thread.deleted", {
        threadId: thread.id,
        deletedAt: "2026-07-05T00:00:00.000Z",
      }),
    );
    expect(deleted.sidebarRecentThreadIds).toEqual([]);
    expect(deleted.sidebarPinnedThreadIds).toEqual([]);
  });

  it("backfills bounded membership from the authoritative catalog after removal", () => {
    const existingThread = makeThread({ id: ThreadId.makeUnsafe("existing") });
    const state = {
      ...makeState(existingThread),
      sidebarThreadsById: { [existingThread.id]: buildSidebarThreadSummary(existingThread) },
      sidebarRecentThreadIds: [existingThread.id],
    };
    const summaries = Array.from({ length: 6 }, (_, index) =>
      makeSummary(ThreadId.makeUnsafe(`chat-${index}`), BUILT_IN_CHATS_PROJECT_ID, {
        createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );

    const next = reconcileSidebarCatalog(state, {
      projectionSequence: 12,
      threads: summaries,
      recentThreadIds: [
        ThreadId.makeUnsafe("missing-recent"),
        ...summaries
          .slice(0, SIDEBAR_THREAD_CATALOG_MAX_RECENT_MEMBERS)
          .map((summary) => summary.id),
      ],
      pinnedThreadIds: [
        ThreadId.makeUnsafe("missing-pin"),
        ...summaries.slice(0, FAVORITE_THREAD_LIMIT).map((summary) => summary.id),
      ],
    });

    expect(next.sidebarRecentThreadIds).toHaveLength(6);
    expect(next.sidebarPinnedThreadIds).toHaveLength(FAVORITE_THREAD_LIMIT);
    expect(next.sidebarThreadsById[summaries[5]!.id]).toBeDefined();
    expect(
      next.sidebarRecentThreadIds.every((id) => next.sidebarThreadsById[id] !== undefined),
    ).toBe(true);
  });
});
