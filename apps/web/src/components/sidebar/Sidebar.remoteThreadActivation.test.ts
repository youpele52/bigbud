import { describe, expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts";
import { resolveRemoteThreadActivation } from "./Sidebar.remoteThreadActivation";

function makeThreadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

describe("resolveRemoteThreadActivation", () => {
  it("returns null for local threads", () => {
    const threadId = makeThreadId("thread-local");

    expect(
      resolveRemoteThreadActivation(
        {
          id: threadId,
          projectId: "project-1" as never,
          workspaceExecutionTargetId: "local",
          title: "Local thread",
          interactionMode: "chat",
          session: null,
          createdAt: "2026-05-16T00:00:00.000Z",
          archivedAt: null,
          latestTurn: null,
          branch: null,
          worktreePath: "/tmp/project",
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        } as never,
        new Map(),
      ),
    ).toBeNull();
  });

  it("returns the remote workspace target and cwd for remote threads", () => {
    const threadId = makeThreadId("thread-remote");
    const projectCwdById = new Map([["project-1" as never, "/srv/project"]]);

    expect(
      resolveRemoteThreadActivation(
        {
          id: threadId,
          projectId: "project-1" as never,
          workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
          title: "Remote thread",
          interactionMode: "chat",
          session: null,
          createdAt: "2026-05-16T00:00:00.000Z",
          archivedAt: null,
          latestTurn: null,
          branch: null,
          worktreePath: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        } as never,
        projectCwdById,
      ),
    ).toEqual({
      threadId,
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      cwd: "/srv/project",
    });
  });
});
