import { BUILT_IN_CHATS_PROJECT_ID, ProjectId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";
import { resolveNewThreadShortcutTarget } from "./useHandleNewThread.shortcuts";

const projectId = ProjectId.makeUnsafe("project");
const otherProjectId = ProjectId.makeUnsafe("other-project");
const empty = { activeThread: null, activeDraftThread: null, selectedProjectId: null };
const local = { branch: null, worktreePath: null, envMode: "local" };

describe("resolveNewThreadShortcutTarget", () => {
  it("uses Chats with no selection, rather than an arbitrary catalog project", () => {
    expect(resolveNewThreadShortcutTarget({ ...empty, command: "chat.new" })).toEqual({
      projectId: BUILT_IN_CHATS_PROJECT_ID,
      options: local,
    });
  });

  it("uses the selected project when no thread is active", () => {
    expect(
      resolveNewThreadShortcutTarget({
        ...empty,
        command: "chat.new",
        selectedProjectId: projectId,
      }),
    ).toEqual({ projectId, options: local });
  });

  it("preserves the active thread's worktree ahead of draft and selected-project context", () => {
    expect(
      resolveNewThreadShortcutTarget({
        command: "chat.new",
        selectedProjectId: otherProjectId,
        activeThread: { projectId, branch: "feature", worktreePath: "/worktree" },
        activeDraftThread: { projectId: otherProjectId, branch: "other", worktreePath: "/other" },
      }),
    ).toEqual({
      projectId,
      options: { branch: "feature", worktreePath: "/worktree", envMode: "worktree" },
    });
  });

  it("does not fill an active local thread's null context from another draft", () => {
    expect(
      resolveNewThreadShortcutTarget({
        ...empty,
        command: "chat.new",
        activeThread: { projectId, branch: null, worktreePath: null },
        activeDraftThread: {
          projectId: otherProjectId,
          branch: "other",
          worktreePath: "/other",
          envMode: "worktree",
        },
      }),
    ).toEqual({ projectId, options: local });
  });

  it("preserves active draft context ahead of the selected project", () => {
    expect(
      resolveNewThreadShortcutTarget({
        ...empty,
        command: "chat.new",
        selectedProjectId: otherProjectId,
        activeDraftThread: {
          projectId,
          branch: "draft",
          worktreePath: "/draft",
          envMode: "worktree",
        },
      }),
    ).toEqual({
      projectId,
      options: { branch: "draft", worktreePath: "/draft", envMode: "worktree" },
    });
  });

  it.each(["chat.new", "chat.newLocal"] as const)(
    "clears context for built-in Chats (%s)",
    (command) => {
      expect(
        resolveNewThreadShortcutTarget({
          ...empty,
          command,
          activeThread: {
            projectId: BUILT_IN_CHATS_PROJECT_ID,
            branch: "old",
            worktreePath: "/old",
          },
        }),
      ).toEqual({ projectId: BUILT_IN_CHATS_PROJECT_ID, options: local });
    },
  );

  it.each([
    empty,
    { ...empty, selectedProjectId: projectId },
    { ...empty, activeThread: { projectId, branch: "feature", worktreePath: "/worktree" } },
    { ...empty, activeDraftThread: { projectId, branch: "draft", worktreePath: "/draft" } },
  ])("always targets base Chats for chat.newLocal: %j", (context) => {
    expect(resolveNewThreadShortcutTarget({ ...context, command: "chat.newLocal" })).toEqual({
      projectId: BUILT_IN_CHATS_PROJECT_ID,
      options: local,
    });
  });
});
