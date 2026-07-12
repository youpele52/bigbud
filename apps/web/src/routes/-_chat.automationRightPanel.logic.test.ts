import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { resolveMostRecentThreadId } from "~/components/sidebar/Sidebar.sort.logic";
import { isAutomationRoute } from "~/lib/automationRoute";
import { navigateToMostRecentThread } from "~/routes/-_chat.automationRightPanel.logic";

describe("isAutomationRoute", () => {
  it("matches automation list and detail routes", () => {
    expect(isAutomationRoute("/automations")).toBe(true);
    expect(isAutomationRoute("/automations/")).toBe(true);
    expect(isAutomationRoute("/automations/automation-1")).toBe(true);
  });

  it("does not match chat routes", () => {
    expect(isAutomationRoute("/")).toBe(false);
    expect(isAutomationRoute("/thread-1")).toBe(false);
    expect(isAutomationRoute("/settings/general")).toBe(false);
  });
});

describe("resolveMostRecentThreadId", () => {
  it("returns the most recently updated visible thread", () => {
    const threadId = resolveMostRecentThreadId(
      [
        {
          id: ThreadId.makeUnsafe("thread-old"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          archivedAt: null,
          deletingAt: null,
        },
        {
          id: ThreadId.makeUnsafe("thread-new"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
          archivedAt: null,
          deletingAt: null,
        },
      ],
      "updated_at",
    );

    expect(threadId).toBe(ThreadId.makeUnsafe("thread-new"));
  });

  it("ignores archived and deleting threads", () => {
    const threadId = resolveMostRecentThreadId(
      [
        {
          id: ThreadId.makeUnsafe("thread-archived"),
          createdAt: "2026-03-09T12:00:00.000Z",
          updatedAt: "2026-03-09T12:00:00.000Z",
          archivedAt: "2026-03-09T12:00:00.000Z",
          deletingAt: null,
        },
        {
          id: ThreadId.makeUnsafe("thread-active"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          archivedAt: null,
          deletingAt: null,
        },
      ],
      "updated_at",
    );

    expect(threadId).toBe(ThreadId.makeUnsafe("thread-active"));
  });

  it("ignores Sidecar threads", () => {
    const threadId = resolveMostRecentThreadId(
      [
        {
          id: ThreadId.makeUnsafe("sidecar"),
          purpose: "side-chat" as const,
          createdAt: "2026-03-09T12:00:00.000Z",
          updatedAt: "2026-03-09T12:00:00.000Z",
          archivedAt: null,
          deletingAt: null,
        },
        {
          id: ThreadId.makeUnsafe("thread-active"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          archivedAt: null,
          deletingAt: null,
        },
      ],
      "updated_at",
    );

    expect(threadId).toBe(ThreadId.makeUnsafe("thread-active"));
  });
});

describe("navigateToMostRecentThread", () => {
  it("navigates to the most recent thread when one exists", async () => {
    const navigate = vi.fn(async () => undefined);

    await navigateToMostRecentThread({
      navigate,
      sortOrder: "updated_at",
      threads: [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          archivedAt: null,
          deletingAt: null,
        },
      ],
    });

    expect(navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: ThreadId.makeUnsafe("thread-1") },
    });
  });

  it("falls back to the chat index when no threads are available", async () => {
    const navigate = vi.fn(async () => undefined);

    await navigateToMostRecentThread({
      navigate,
      sortOrder: "updated_at",
      threads: [],
    });

    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });
});
