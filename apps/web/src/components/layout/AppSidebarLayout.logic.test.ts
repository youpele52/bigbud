import { describe, expect, it } from "vitest";

import { isThreadNavigationAvailable, parseOpenThreadAction } from "./AppSidebarLayout.logic";
import type { Thread } from "../../models/types";

function makeThread(overrides?: Partial<Thread>): Thread {
  return {
    id: "thread-1" as never,
    codexThreadId: null,
    projectId: "project-1" as never,
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" } as never,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-09-28T00:00:00.000Z",
    archivedAt: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    latestTurn: null,
    ...overrides,
  };
}

describe("AppSidebarLayout thread actions", () => {
  it("parses only non-empty open-thread actions", () => {
    expect(parseOpenThreadAction("open-thread: thread-1 ")).toBe("thread-1");
    expect(parseOpenThreadAction("open-thread:")).toBeNull();
    expect(parseOpenThreadAction("open-settings")).toBeNull();
  });

  it("accepts loaded and sidebar-known threads", () => {
    expect(
      isThreadNavigationAvailable("thread-1", {
        threads: [makeThread()],
        sidebarThreadsById: {},
      }),
    ).toBe(true);
    expect(
      isThreadNavigationAvailable("thread-2", {
        threads: [],
        sidebarThreadsById: {
          "thread-2": {
            id: "thread-2" as never,
            deletingAt: null,
          } as never,
        },
      }),
    ).toBe(true);
  });

  it("rejects missing, side-chat, and deleting targets", () => {
    expect(isThreadNavigationAvailable("missing", { threads: [], sidebarThreadsById: {} })).toBe(
      false,
    );
    expect(
      isThreadNavigationAvailable("thread-1", {
        threads: [makeThread({ purpose: "side-chat" })],
        sidebarThreadsById: {},
      }),
    ).toBe(false);
    expect(
      isThreadNavigationAvailable("thread-1", {
        threads: [makeThread({ deletingAt: "2026-09-28T00:00:00.000Z" })],
        sidebarThreadsById: {},
      }),
    ).toBe(false);
  });
});
