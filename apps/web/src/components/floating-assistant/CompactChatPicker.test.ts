import { BUILT_IN_CHATS_PROJECT_ID, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadStatusPill } from "~/components/sidebar/Sidebar.logic";
import { sortThreadsForSidebar } from "~/components/sidebar/Sidebar.sort.logic";
import { collectVisibleChatThreads } from "~/components/sidebar/Sidebar.state.visibleThreads";
import type { SidebarThreadSummary } from "~/models/types";

function makeSummary(
  overrides: Partial<SidebarThreadSummary> & Pick<SidebarThreadSummary, "id" | "title">,
): SidebarThreadSummary {
  return {
    projectId: BUILT_IN_CHATS_PROJECT_ID,
    interactionMode: "default",
    session: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    updatedAt: "2026-08-19T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("compact chat picker thread lists", () => {
  it("sorts sidebar recents by recency instead of catalog id order", () => {
    const older = makeSummary({
      id: ThreadId.makeUnsafe("older"),
      title: "Fix CI",
      latestUserMessageAt: "2026-08-19T00:01:00.000Z",
    });
    const newest = makeSummary({
      id: ThreadId.makeUnsafe("newest"),
      title: "Conversation kickoff",
      latestUserMessageAt: "2026-08-19T00:02:00.000Z",
    });

    expect(
      sortThreadsForSidebar(
        collectVisibleChatThreads({
          loadedChatThreadIds: [newest.id],
          sidebarRecentThreadIds: [older.id],
          sidebarThreadsById: { [older.id]: older, [newest.id]: newest },
        }),
        "updated_at",
      ).map((thread) => thread.title),
    ).toEqual(["Conversation kickoff", "Fix CI"]);
  });

  it("clears the completed marker after the thread is read", () => {
    const thread = makeSummary({
      id: ThreadId.makeUnsafe("completed"),
      title: "Latest AI stock news",
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        assistantMessageId: null,
        requestedAt: "2026-08-19T00:00:00.000Z",
        startedAt: "2026-08-19T00:00:00.000Z",
        completedAt: "2026-08-19T00:05:00.000Z",
      },
      session: {
        provider: "codex",
        status: "ready",
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:05:00.000Z",
        orchestrationStatus: "ready",
      },
    });

    expect(
      resolveThreadStatusPill({
        thread: { ...thread, lastVisitedAt: undefined },
      }),
    ).toMatchObject({
      label: "Done",
    });
    expect(
      resolveThreadStatusPill({
        thread: { ...thread, lastVisitedAt: "2026-08-19T00:06:00.000Z" },
      }),
    ).toMatchObject({ label: "Idle" });
  });
});
