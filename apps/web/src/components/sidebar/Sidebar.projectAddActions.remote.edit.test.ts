import { describe, expect, it, vi } from "vitest";

import {
  collectRemoteProjectWorktreePaths,
  reconfigureRemoteProjectWithApi,
} from "./Sidebar.projectAddActions.remote.edit";

describe("collectRemoteProjectWorktreePaths", () => {
  it("returns unique worktrees for live project threads", () => {
    expect(
      collectRemoteProjectWorktreePaths(
        {
          projects: [],
          threads: [
            { projectId: "project-1", worktreePath: "/srv/worktree-a", deletedAt: null },
            { projectId: "project-1", worktreePath: "/srv/worktree-a", deletedAt: null },
            { projectId: "project-1", worktreePath: "/srv/deleted", deletedAt: "2026-01-01" },
            { projectId: "project-2", worktreePath: "/srv/other", deletedAt: null },
          ],
        } as never,
        "project-1" as never,
      ),
    ).toEqual(["/srv/worktree-a"]);
  });

  it("verifies retained worktrees before dispatching the revision-guarded command", async () => {
    const verifyExecutionTarget = vi.fn().mockResolvedValue({ message: "verified" });
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 1 });
    const error = await reconfigureRemoteProjectWithApi({
      api: {
        server: { verifyExecutionTarget },
        orchestration: {
          getSnapshot: vi.fn().mockResolvedValue({
            projects: [],
            threads: [
              {
                projectId: "project-1",
                worktreePath: "/srv/worktree-a",
                deletedAt: null,
              },
            ],
          }),
          dispatchCommand,
        },
      } as never,
      projectId: "project-1" as never,
      title: "Remote project",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      draft: {
        displayName: "Remote project",
        host: "devbox",
        username: "alice",
        port: "22",
        workspaceRoot: "/srv/project",
        sshKeyPath: "",
        authMode: "ssh-key",
        providerRuntimeLocation: "local",
      },
    });

    expect(error).toBeNull();
    expect(verifyExecutionTarget).toHaveBeenCalledWith({
      executionTargetId: "ssh:host=devbox&user=alice&port=22&auth=ssh-key",
      cwd: "/srv/worktree-a",
    });
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.reconfigure",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        verifiedWorktreePaths: ["/srv/worktree-a"],
      }),
    );
  });

  it("keeps the edit pending when a retained worktree cannot be verified", async () => {
    const dispatchCommand = vi.fn();
    const error = await reconfigureRemoteProjectWithApi({
      api: {
        server: { verifyExecutionTarget: vi.fn().mockRejectedValue(new Error("missing worktree")) },
        orchestration: {
          getSnapshot: vi.fn().mockResolvedValue({
            projects: [],
            threads: [{ projectId: "project-1", worktreePath: "/srv/worktree-a", deletedAt: null }],
          }),
          dispatchCommand,
        },
      } as never,
      projectId: "project-1" as never,
      title: "Remote project",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      draft: {
        displayName: "Remote project",
        host: "devbox",
        username: "alice",
        port: "22",
        workspaceRoot: "/srv/project",
        sshKeyPath: "",
        authMode: "ssh-key",
        providerRuntimeLocation: "local",
      },
    });

    expect(error).toContain("The new SSH target cannot access these worktrees");
    expect(error).toContain("/srv/worktree-a: missing worktree");
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});
