import { describe, expect, it } from "vitest";

import { derivePendingApprovals, sortThreads } from "./mobileModels";

describe("mobileModels", () => {
  it("keeps unresolved approvals open", () => {
    const approvals = derivePendingApprovals([
      {
        id: "event-1",
        tone: "approval",
        kind: "approval.requested",
        summary: "Approval requested",
        payload: { requestId: "req-1", requestType: "exec_command_approval" },
        turnId: null,
        createdAt: "2026-06-24T12:00:00.000Z",
      },
    ] as never);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.requestKind).toBe("command");
  });

  it("sorts pending-approval threads ahead of others", () => {
    const snapshot = {
      snapshotSequence: 1,
      updatedAt: "2026-06-24T12:00:00.000Z",
      projects: [
        {
          id: "project-1",
          title: "Project",
          workspaceRoot: null,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          scripts: [],
          createdAt: "2026-06-24T12:00:00.000Z",
          updatedAt: "2026-06-24T12:00:00.000Z",
          deletingAt: null,
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: "thread-1",
          projectId: "project-1",
          title: "Needs approval",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-06-24T12:00:00.000Z",
          updatedAt: "2026-06-24T12:00:00.000Z",
          archivedAt: null,
          deletingAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [
            {
              id: "event-1",
              tone: "approval",
              kind: "approval.requested",
              summary: "Approval",
              payload: { requestId: "req-1" },
              turnId: null,
              createdAt: "2026-06-24T12:00:00.000Z",
            },
          ],
          checkpoints: [],
          session: null,
        },
        {
          id: "thread-2",
          projectId: "project-1",
          title: "No approval",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-06-24T12:00:00.000Z",
          updatedAt: "2026-06-24T11:00:00.000Z",
          archivedAt: null,
          deletingAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    } as never;

    expect(sortThreads(snapshot)[0]?.id).toBe("thread-1");
  });
});
