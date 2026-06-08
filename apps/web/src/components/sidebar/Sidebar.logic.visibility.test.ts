import { describe, expect, it } from "vitest";

import { ThreadId } from "@bigbud/contracts";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../../models/types";
import {
  getHiddenSidebarThreadCount,
  getVisibleRecentThreadIds,
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  resolveAdjacentThreadId,
} from "./Sidebar.logic";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: "project-1" as never,
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("returns only the rendered visible thread order across projects", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          renderedThreadIds: [
            ThreadId.makeUnsafe("thread-12"),
            ThreadId.makeUnsafe("thread-11"),
            ThreadId.makeUnsafe("thread-10"),
          ],
        },
        {
          renderedThreadIds: [ThreadId.makeUnsafe("thread-8"), ThreadId.makeUnsafe("thread-6")],
        },
      ]),
    ).toEqual([
      ThreadId.makeUnsafe("thread-12"),
      ThreadId.makeUnsafe("thread-11"),
      ThreadId.makeUnsafe("thread-10"),
      ThreadId.makeUnsafe("thread-8"),
      ThreadId.makeUnsafe("thread-6"),
    ]);
  });

  it("skips threads from collapsed projects whose thread panels are not shown", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          shouldShowThreadPanel: false,
          renderedThreadIds: [
            ThreadId.makeUnsafe("thread-hidden-2"),
            ThreadId.makeUnsafe("thread-hidden-1"),
          ],
        },
        {
          shouldShowThreadPanel: true,
          renderedThreadIds: [ThreadId.makeUnsafe("thread-12"), ThreadId.makeUnsafe("thread-11")],
        },
      ]),
    ).toEqual([ThreadId.makeUnsafe("thread-12"), ThreadId.makeUnsafe("thread-11")]);
  });

  it("can prepend visible recent chats before project threads", () => {
    const recentThreadIds = [ThreadId.makeUnsafe("chat-2"), ThreadId.makeUnsafe("chat-1")];
    expect([
      ...recentThreadIds,
      ...getVisibleSidebarThreadIds([
        {
          shouldShowThreadPanel: true,
          renderedThreadIds: [ThreadId.makeUnsafe("thread-12")],
        },
      ]),
    ]).toEqual([
      ThreadId.makeUnsafe("chat-2"),
      ThreadId.makeUnsafe("chat-1"),
      ThreadId.makeUnsafe("thread-12"),
    ]);
  });
});

describe("getVisibleRecentThreadIds", () => {
  const threads = [
    ThreadId.makeUnsafe("chat-1"),
    ThreadId.makeUnsafe("chat-2"),
    ThreadId.makeUnsafe("chat-3"),
  ];

  it("returns no recent threads when recents is collapsed", () => {
    expect(
      getVisibleRecentThreadIds({
        renderedChatThreadIds: threads,
        isExpanded: false,
        showAll: true,
        initialVisibleCount: 2,
      }),
    ).toEqual([]);
  });

  it("returns only previewed recent threads before see more is opened", () => {
    expect(
      getVisibleRecentThreadIds({
        renderedChatThreadIds: threads,
        isExpanded: true,
        showAll: false,
        initialVisibleCount: 2,
      }),
    ).toEqual([ThreadId.makeUnsafe("chat-1"), ThreadId.makeUnsafe("chat-2")]);
  });

  it("returns all recent threads after see more is opened", () => {
    expect(
      getVisibleRecentThreadIds({
        renderedChatThreadIds: threads,
        isExpanded: true,
        showAll: true,
        initialVisibleCount: 2,
      }),
    ).toEqual(threads);
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 4,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
      ThreadId.makeUnsafe("thread-8"),
    ]);
    expect(result.hiddenThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-5"),
      ThreadId.makeUnsafe("thread-6"),
      ThreadId.makeUnsafe("thread-7"),
    ]);
  });

  it("returns all threads when the list is expanded", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      isThreadListExpanded: true,
      previewLimit: 4,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
    expect(result.hiddenThreads).toEqual([]);
  });
});

describe("getHiddenSidebarThreadCount", () => {
  it("returns the full hidden project-thread count from total vs rendered threads", () => {
    expect(
      getHiddenSidebarThreadCount({
        totalThreadCount: 12,
        renderedThreadCount: 5,
      }),
    ).toBe(7);
  });

  it("matches project previews that include the active thread outside the folded limit", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 4,
    });

    expect(
      getHiddenSidebarThreadCount({
        totalThreadCount: threads.length,
        renderedThreadCount: result.visibleThreads.length,
      }),
    ).toBe(result.hiddenThreads.length);
  });

  it("never returns a negative count", () => {
    expect(
      getHiddenSidebarThreadCount({
        totalThreadCount: 4,
        renderedThreadCount: 6,
      }),
    ).toBe(0);
  });
});
