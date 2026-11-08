import { describe, expect, it, vi } from "vitest";

import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";

import {
  collectRemoteWorkspaceWorktreePaths,
  reconfigureRemoteWorkspaceWithApi,
} from "./Sidebar.remoteWorkspaceAddActions.edit";

describe("collectRemoteWorkspaceWorktreePaths", () => {
  it("returns unique, non-blank worktrees from the bounded project read", () => {
    expect(
      collectRemoteWorkspaceWorktreePaths({
        worktreePaths: ["/srv/worktree-a", " /srv/worktree-a ", "  ", "/srv/worktree-b"],
      }),
    ).toEqual(["/srv/worktree-a", "/srv/worktree-b"]);
  });

  it("verifies retained worktrees before dispatching the revision-guarded command", async () => {
    const getProjectWorktreePaths = vi.fn().mockResolvedValue({
      projectId: "project-1",
      worktreePaths: ["/srv/worktree-a"],
      truncated: false,
    });
    const verifyExecutionTarget = vi.fn().mockResolvedValue({ message: "verified" });
    const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 1 });
    const error = await reconfigureRemoteWorkspaceWithApi({
      api: {
        server: { verifyExecutionTarget },
        orchestration: {
          getProjectWorktreePaths,
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
    expect(getProjectWorktreePaths).toHaveBeenCalledWith({ projectId: "project-1" });
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
          getProjectWorktreePaths: vi.fn().mockResolvedValue({
            projectId: "project-1",
            worktreePaths: ["/srv/worktree-a"],
            truncated: false,
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

  it("refuses to verify a capped worktree list instead of verifying a subset", async () => {
    const verifyExecutionTarget = vi.fn();
    const dispatchCommand = vi.fn();
    const error = await reconfigureRemoteWorkspaceWithApi({
      api: {
        server: { verifyExecutionTarget },
        orchestration: {
          getProjectWorktreePaths: vi.fn().mockResolvedValue({
            projectId: "project-1",
            worktreePaths: ["/srv/worktree-a"],
            truncated: true,
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

    expect(error).toContain("more than 500 worktrees");
    expect(verifyExecutionTarget).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("connects a disconnected target before verifying, and reports a refused connect", async () => {
    const target = "ssh:host=devbox&user=alice&port=22&auth=ssh-key&transport=agent";
    useRemoteAccessStore.setState({ disconnectedExecutionTargetIds: { [target]: true } });
    const getProjectWorktreePaths = vi
      .fn()
      .mockResolvedValue({ projectId: "project-1", worktreePaths: [], truncated: false });
    const connectExecutionTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connect refused."))
      .mockResolvedValueOnce({ executionTargetId: target, disconnected: false });
    const reconfigure = () =>
      reconfigureRemoteWorkspaceWithApi({
        api: {
          server: { connectExecutionTarget, verifyExecutionTarget: vi.fn() },
          orchestration: {
            getProjectWorktreePaths,
            dispatchCommand: vi.fn().mockResolvedValue({}),
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

    await expect(reconfigure()).resolves.toBe("Connect refused.");
    expect(getProjectWorktreePaths).not.toHaveBeenCalled();
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBe(true);

    await expect(reconfigure()).resolves.toBeNull();
    expect(connectExecutionTarget).toHaveBeenLastCalledWith({ executionTargetId: target });
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBeUndefined();
  });
});
