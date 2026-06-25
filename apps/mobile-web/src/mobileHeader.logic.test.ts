import { BUILT_IN_CHATS_PROJECT_ID, ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { createMobileDraftThread } from "./mobileDraftThread";
import {
  extractMobileThreadId,
  isMobileLaunchRoute,
  resolveMobileHeaderState,
} from "./mobileHeader.logic";

describe("mobileHeader.logic", () => {
  it("detects launch routes", () => {
    expect(isMobileLaunchRoute("/")).toBe(true);
    expect(isMobileLaunchRoute("/mobile")).toBe(true);
    expect(isMobileLaunchRoute("/mobile/chats")).toBe(false);
  });

  it("extracts thread ids from thread routes", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    expect(extractMobileThreadId(`/mobile/thread/${threadId}`)).toBe(threadId);
    expect(extractMobileThreadId(`/mobile/thread/${threadId}/diff`)).toBe(threadId);
  });

  it("shows chats breadcrumb for built-in chat threads", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const header = resolveMobileHeaderState(
      `/mobile/thread/${threadId}`,
      {
        projects: [
          {
            id: BUILT_IN_CHATS_PROJECT_ID,
            title: "Chats",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            workspaceRoot: null,
          },
        ],
        threads: [
          {
            id: threadId,
            projectId: BUILT_IN_CHATS_PROJECT_ID,
            title: "List files in /Users/youpele/Desktop",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            archivedAt: null,
            branch: null,
            worktreePath: null,
            runtimeMode: "local",
            interactionMode: "default",
            messages: [],
            activities: [],
            session: null,
          },
        ],
      } as never,
      null,
    );

    expect(header.breadcrumb).toEqual([
      { label: "Chats", to: "/mobile/chats" },
      { label: "List files in /Users/youpele/Desktop" },
    ]);
    expect(header.backTo).toBe("/mobile/chats");
  });

  it("shows project breadcrumb for project threads", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-2");
    const header = resolveMobileHeaderState(
      `/mobile/thread/${threadId}`,
      {
        projects: [
          {
            id: projectId,
            title: "bigbud",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            workspaceRoot: "/repo",
          },
        ],
        threads: [
          {
            id: threadId,
            projectId,
            title: "Review Mobile Remote Control",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            archivedAt: null,
            branch: null,
            worktreePath: null,
            runtimeMode: "local",
            interactionMode: "default",
            messages: [],
            activities: [],
            session: null,
          },
        ],
      } as never,
      null,
    );

    expect(header.breadcrumb).toEqual([
      { label: "bigbud", to: `/mobile/projects/${projectId}` },
      { label: "Review Mobile Remote Control" },
    ]);
    expect(header.backTo).toBe(`/mobile/projects/${projectId}`);
  });

  it("uses draft thread project for new chat breadcrumbs", () => {
    const draft = createMobileDraftThread(BUILT_IN_CHATS_PROJECT_ID);
    const header = resolveMobileHeaderState(`/mobile/thread/${draft.threadId}`, undefined, draft);

    expect(header.breadcrumb?.[0]).toEqual({ label: "Chats", to: "/mobile/chats" });
    expect(header.backTo).toBe("/mobile/chats");
  });

  it("falls back to the launch header on diff routes", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const header = resolveMobileHeaderState(`/mobile/thread/${threadId}/diff`, undefined, null);

    expect(header.showBack).toBe(false);
    expect(header.backTo).toBe("/mobile");
  });
});
