import { describe, expect, it, vi } from "vitest";

import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";

import {
  collectRemoteWorkspaceWorktreePaths,
  reconfigureRemoteWorkspaceWithApi,
} from "./Sidebar.remoteWorkspaceAddActions.edit";

describe("collectRemoteWorkspaceWorktreePaths", () => {
  it("returns unique worktrees for live project threads", () => {
    expect(
      collectRemoteWorkspaceWorktreePaths(
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
    const error = await reconfigureRemoteWorkspaceWithApi({
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
        remoteTransport: "agent",
        providerRuntimeLocation: "local",
        connectionSource: "manual",
        inactiveConnection: {
          host: "",
          username: "",
          port: "",
          sshKeyPath: "",
          authMode: "ssh-key",
        },
      },
    });

    expect(error).toBeNull();
    expect(verifyExecutionTarget).toHaveBeenCalledWith({
      executionTargetId: "ssh:host=devbox&user=alice&port=22&auth=ssh-key&transport=agent",
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
    const error = await reconfigureRemoteWorkspaceWithApi({
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
        remoteTransport: "agent",
        providerRuntimeLocation: "local",
        connectionSource: "manual",
        inactiveConnection: {
          host: "",
          username: "",
          port: "",
          sshKeyPath: "",
          authMode: "ssh-key",
        },
      },
    });

    expect(error).toContain("The new SSH target cannot access these worktrees");
    expect(error).toContain("/srv/worktree-a: missing worktree");
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("connects a disconnected target before verifying, and reports a refused connect", async () => {
    const target = "ssh:host=devbox&user=alice&port=22&auth=ssh-key&transport=agent";
    useRemoteAccessStore.setState({ disconnectedExecutionTargetIds: { [target]: true } });
    const getSnapshot = vi.fn().mockResolvedValue({ projects: [], threads: [] });
    const connectExecutionTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connect refused."))
      .mockResolvedValueOnce({ executionTargetId: target, disconnected: false });
    const reconfigure = () =>
      reconfigureRemoteWorkspaceWithApi({
        api: {
          server: { connectExecutionTarget, verifyExecutionTarget: vi.fn() },
          orchestration: { getSnapshot, dispatchCommand: vi.fn().mockResolvedValue({}) },
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
          remoteTransport: "agent",
          providerRuntimeLocation: "local",
          connectionSource: "manual",
          inactiveConnection: {
            host: "",
            username: "",
            port: "",
            sshKeyPath: "",
            authMode: "ssh-key",
          },
        },
      });

    await expect(reconfigure()).resolves.toBe("Connect refused.");
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBe(true);

    await expect(reconfigure()).resolves.toBeNull();
    expect(connectExecutionTarget).toHaveBeenLastCalledWith({ executionTargetId: target });
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBeUndefined();
  });
});
