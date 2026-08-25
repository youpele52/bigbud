import type { ProjectId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { Project } from "~/models/types";
import type { DraftThreadState } from "~/stores/composer";
import { resolveWorkspaceContext } from "./useResolvedWorkspace";

const serverProjectId = "server-project" as ProjectId;
const draftProjectId = "draft-project" as ProjectId;
const selectedProjectId = "selected-project" as ProjectId;

function draftThread(overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    projectId: draftProjectId,
    createdAt: "2026-08-24T00:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/worktrees/draft",
    envMode: "worktree",
    ...overrides,
  };
}

const project = {
  id: draftProjectId,
  cwd: "/projects/draft",
} as Project;

describe("resolveWorkspaceContext", () => {
  it("prefers the server thread project and worktree", () => {
    expect(
      resolveWorkspaceContext({
        serverThread: { projectId: serverProjectId, worktreePath: "/worktrees/server" },
        draftThread: draftThread(),
        selectedProjectId,
        project,
        defaultChatCwd: "/default",
      }),
    ).toEqual({ projectId: serverProjectId, cwd: "/worktrees/server" });
  });

  it("uses the draft thread project and worktree before selected project fallbacks", () => {
    expect(
      resolveWorkspaceContext({
        serverThread: undefined,
        draftThread: draftThread(),
        selectedProjectId,
        project,
        defaultChatCwd: "/default",
      }),
    ).toEqual({ projectId: draftProjectId, cwd: "/worktrees/draft" });
  });

  it("falls back from a draft project to its cwd and then the default chat cwd", () => {
    expect(
      resolveWorkspaceContext({
        serverThread: undefined,
        draftThread: draftThread({ worktreePath: null }),
        selectedProjectId,
        project,
        defaultChatCwd: "/default",
      }),
    ).toEqual({ projectId: draftProjectId, cwd: "/projects/draft" });

    expect(
      resolveWorkspaceContext({
        serverThread: undefined,
        draftThread: null,
        selectedProjectId,
        project: undefined,
        defaultChatCwd: "/default",
      }),
    ).toEqual({ projectId: selectedProjectId, cwd: "/default" });
  });
});
