import type { ProjectId, ThreadId, ThreadSummary, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { isLatestTurnSettled } from "../../logic/session/session.logic";
import { mapThreadSummary } from "./mappers.lazy.store";
import { syncBoundedCatalog, syncSidebarCatalog } from "./helpers.lazy.store";
import { useStore } from "./main.store";

const UPDATED_AT = "2026-03-04T12:00:00.000Z";

function summary(overrides: Partial<ThreadSummary>): ThreadSummary {
  return {
    id: "thread-1" as ThreadId,
    projectId: "project-1" as ProjectId,
    title: "Thread",
    purpose: "standard",
    elevatorSummary: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    branch: "main",
    worktreePath: null,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    latestUserMessageAt: UPDATED_AT,
    pinnedAt: null,
    sessionStatus: "ready",
    providerName: "codex",
    activeTurnId: "turn-1" as TurnId,
    latestTurnState: "completed",
    isWatching: false,
    isWatched: false,
    isDelegated: false,
    isAwaitingApproval: false,
    ...overrides,
  } as ThreadSummary;
}

describe("bounded notification summary ordering", () => {
  it.each([true, false])(
    "keeps newest evidence regardless of catalog source (sidebar newest: %s)",
    (sidebarNewest) => {
      const old = summary({ title: "Old" });
      const current = summary({
        title: "Current",
        notificationSafety: {
          turnId: "turn-1" as TurnId,
          tasks: [],
          childThreadIds: [],
          pendingRequestIds: ["pending"],
          queuedPromptIds: [],
          overflow: false,
        },
      });
      const sidebar = {
        projectionSequence: sidebarNewest ? 20 : 19,
        threads: [sidebarNewest ? current : old],
        recentThreadIds: [],
        pinnedThreadIds: [],
        projectThreadCounts: [],
      };
      const page = {
        projectionSequence: sidebarNewest ? 19 : 20,
        projectId: current.projectId,
        threads: [sidebarNewest ? old : current],
      };
      const initial = { ...useStore.getState(), threads: [], sidebarThreadsById: {} };
      const next = syncBoundedCatalog(initial, {}, {}, {}, sidebar, [page]);
      expect(next.threads[0]?.title).toBe("Current");
      expect(next.threads[0]?.notificationSafetySequence).toBe(20);
      expect(next.threads[0]?.notificationSafety?.pendingRequestIds).toEqual(["pending"]);
      const stale = syncSidebarCatalog(next, {
        ...sidebar,
        projectionSequence: 19,
        threads: [old],
      });
      expect(stale.threads[0]).toBe(next.threads[0]);
    },
  );
});

describe("mapThreadSummary latest turn", () => {
  it.each(["completed", "interrupted", "error"] as const)(
    "treats a %s turn from the startup catalog as settled",
    (latestTurnState) => {
      const thread = mapThreadSummary(summary({ latestTurnState }));

      expect(thread.latestTurn).toMatchObject({
        turnId: "turn-1",
        state: latestTurnState,
        startedAt: UPDATED_AT,
        completedAt: UPDATED_AT,
      });
      expect(isLatestTurnSettled(thread.latestTurn, thread.session)).toBe(true);
    },
  );

  it("keeps a running turn open", () => {
    const thread = mapThreadSummary(summary({ latestTurnState: "running" }));

    expect(thread.latestTurn).toMatchObject({ startedAt: UPDATED_AT, completedAt: null });
  });
});
