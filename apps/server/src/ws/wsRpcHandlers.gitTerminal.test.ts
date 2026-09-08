import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { WS_METHODS } from "@bigbud/contracts";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { makeWsRpcGitTerminalHandlers } from "./wsRpcHandlers.gitTerminal.ts";

describe("Git RPC mutation operation identity", () => {
  it("preserves supplied ids and generates one for legacy inputs", async () => {
    const pullCurrentBranch = vi.fn(() =>
      Effect.succeed({
        status: "skipped_up_to_date" as const,
        branch: "main",
        upstreamBranch: "origin/main",
      }),
    );
    const createBranch = vi.fn(
      (input: { readonly branch: string; readonly operationId?: string }) =>
        Effect.succeed({ branch: input.branch }),
    );
    const context = {
      git: { pullCurrentBranch, createBranch },
      refreshGitStatus: vi.fn(() => Effect.void),
    } as unknown as WsRpcContext;
    const handlers = makeWsRpcGitTerminalHandlers(context);

    await Effect.runPromise(
      handlers[WS_METHODS.gitPull]({
        cwd: "/repo",
        operationId: "git-retry-1",
      }),
    );
    await Effect.runPromise(
      handlers[WS_METHODS.gitCreateBranch]({
        cwd: "/repo",
        branch: "feature/new",
      }),
    );

    expect(pullCurrentBranch).toHaveBeenCalledWith("/repo", undefined, "git-retry-1");
    expect(createBranch.mock.calls[0]?.[0].operationId).toMatch(/^git-rpc-/);
  });

  it("forwards preparation operation identity to GitManager", async () => {
    const preparePullRequestThread = vi.fn(() =>
      Effect.succeed({
        pullRequest: {},
        branch: "feature/new",
        worktreePath: null,
      }),
    );
    const context = {
      gitManager: { preparePullRequestThread },
      refreshGitStatus: vi.fn(() => Effect.void),
    } as unknown as WsRpcContext;
    const handlers = makeWsRpcGitTerminalHandlers(context);

    await Effect.runPromise(
      handlers[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "#42",
        mode: "worktree",
        operationId: "prepare-retry-1",
      }),
    );

    expect(preparePullRequestThread).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "prepare-retry-1" }),
    );
  });

  it("exposes persisted remote update and reconnect status without selecting a build", async () => {
    const getStatus = vi.fn().mockResolvedValue({
      executionTargetId: "ssh:test",
      root: "/remote/agent",
      phase: "ready-for-reconnect",
      requestId: "update-207",
      reconnectRequestId: "reconnect-1",
      reconnectOutcome: "pending",
      currentVersion: "0.2.205",
      candidateVersion: "0.2.207",
      predecessorVersion: null,
      outcome: "ready",
      reason: null,
    });
    const handlers = makeWsRpcGitTerminalHandlers({
      remoteAgentUpdateCoordinator: { getStatus },
    } as unknown as WsRpcContext);

    const result = await Effect.runPromise(
      handlers[WS_METHODS.serverGetRemoteAgentUpdateStatus]({
        executionTargetId: "ssh:test",
        reconnectRequestId: "reconnect-1",
      }),
    );

    expect(getStatus).toHaveBeenCalledWith("ssh:test", "reconnect-1");
    expect(result).toMatchObject({
      phase: "ready-for-next-reconnect",
      updateRequestId: "update-207",
      pendingVersion: "0.2.207",
    });
  });
});
