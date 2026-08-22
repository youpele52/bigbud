import { BUILT_IN_CHATS_PROJECT_ID, ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { Project, SidebarThreadSummary } from "../../models/types";
import {
  COMPOSER_PICKER_RECENT_LIMIT,
  getComposerPickerChatRecents,
  getComposerPickerProjects,
} from "./ComposerProjectPicker.logic";

function project(id: string, name: string): Project {
  return {
    id: ProjectId.makeUnsafe(id),
    name,
    cwd: null,
    defaultModelSelection: null,
    scripts: [],
  };
}

function thread(id: string, projectId: ProjectId, createdAt: string): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt,
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: createdAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("composer project picker logic", () => {
  it("returns at most four recent Chats threads", () => {
    const chatsProjectId = BUILT_IN_CHATS_PROJECT_ID;
    const otherProjectId = ProjectId.makeUnsafe("other");
    const threads = [
      thread("chat-1", chatsProjectId, "2026-01-01T00:00:00.000Z"),
      thread("chat-2", chatsProjectId, "2026-01-02T00:00:00.000Z"),
      thread("chat-3", chatsProjectId, "2026-01-03T00:00:00.000Z"),
      thread("chat-4", chatsProjectId, "2026-01-04T00:00:00.000Z"),
      thread("chat-5", chatsProjectId, "2026-01-05T00:00:00.000Z"),
      thread("project-thread", otherProjectId, "2026-01-06T00:00:00.000Z"),
    ];
    const sidebarThreadsById = Object.fromEntries(threads.map((item) => [item.id, item]));

    const result = getComposerPickerChatRecents({
      loadedChatThreadIds: threads.map((item) => item.id),
      sidebarRecentThreadIds: threads.map((item) => item.id),
      sidebarThreadsById,
      sortOrder: "updated_at",
    });

    expect(result).toHaveLength(COMPOSER_PICKER_RECENT_LIMIT);
    expect(result.map((item) => item.id)).toEqual(["chat-5", "chat-4", "chat-3", "chat-2"]);
  });

  it("pins Chats before sorted projects", () => {
    const chats = project(BUILT_IN_CHATS_PROJECT_ID, "Chats");
    const alpha = project("alpha", "Alpha");
    const beta = project("beta", "Beta");

    const result = getComposerPickerProjects({
      projectOrder: [beta.id, alpha.id, chats.id],
      projects: [alpha, chats, beta],
      sidebarThreadsById: {},
      sortOrder: "manual",
    });

    expect(result.map((item) => item.id)).toEqual([chats.id, beta.id, alpha.id]);
  });
});
