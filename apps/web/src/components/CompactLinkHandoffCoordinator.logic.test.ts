import { describe, expect, it, vi } from "vitest";

import {
  handleCompactLinkHandoff,
  resolveCompactLinkWorkspaceRoot,
} from "./CompactLinkHandoffCoordinator.logic";

const action = {
  type: "compact-chat-link" as const,
  threadId: "thread-1",
  href: "src/index.ts:4",
  workspaceRoot: "/compact/worktree",
};

describe("compact link handoff handling", () => {
  it("awaits source-thread navigation before opening a file target", async () => {
    const events: string[] = [];
    let resolveNavigation!: () => void;
    const navigateToThread = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveNavigation = resolve;
        }),
    );
    const openFile = vi.fn(() => events.push("open-file"));

    const handling = handleCompactLinkHandoff({
      action,
      navigateToThread: async (threadId) => {
        events.push(`navigate:${threadId}`);
        await navigateToThread();
      },
      workspaceRoot: () => action.workspaceRoot ?? undefined,
      isCurrent: () => true,
      openFile,
      openBrowser: vi.fn(),
    });

    await Promise.resolve();
    expect(events).toEqual(["navigate:thread-1"]);
    expect(openFile).not.toHaveBeenCalled();
    resolveNavigation();
    await handling;
    expect(openFile).toHaveBeenCalledWith("/compact/worktree/src/index.ts:4", "/compact/worktree");
  });

  it("uses the compact workspace root over a fallback root", () => {
    expect(resolveCompactLinkWorkspaceRoot(action, "/main/project")).toBe("/compact/worktree");
    expect(
      resolveCompactLinkWorkspaceRoot({ ...action, workspaceRoot: null }, "/main/project"),
    ).toBe("/main/project");
  });

  it("opens sanitized external links in the browser and drops stale requests", async () => {
    const openBrowser = vi.fn();
    const openFile = vi.fn();
    await handleCompactLinkHandoff({
      action: { ...action, href: "https://localhost:4321/docs" },
      navigateToThread: async () => undefined,
      workspaceRoot: () => "/workspace",
      isCurrent: () => true,
      openFile,
      openBrowser,
    });
    expect(openBrowser).toHaveBeenCalledWith("https://localhost:4321/docs");

    await handleCompactLinkHandoff({
      action: { ...action, href: "https://example.com" },
      navigateToThread: async () => undefined,
      workspaceRoot: () => "/workspace",
      isCurrent: () => false,
      openFile,
      openBrowser,
    });
    expect(openBrowser).toHaveBeenCalledOnce();
  });
});
