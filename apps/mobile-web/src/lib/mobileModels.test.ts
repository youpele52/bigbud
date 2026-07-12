import { BUILT_IN_CHATS_PROJECT_ID, ProjectId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  chatThreadsForMobile,
  derivePendingApprovals,
  derivePendingUserInputs,
  resolveThreadWorkspaceRoot,
  sortThreads,
} from "./mobileModels";

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

  it("drops approvals once they are resolved", () => {
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
      {
        id: "event-2",
        tone: "approval",
        kind: "approval.resolved",
        summary: "Approval resolved",
        payload: { requestId: "req-1" },
        turnId: null,
        createdAt: "2026-06-24T12:00:01.000Z",
      },
    ] as never);

    expect(approvals).toHaveLength(0);
  });

  it("keeps unresolved user-input prompts open", () => {
    const pending = derivePendingUserInputs([
      {
        id: "event-1",
        tone: "user-input",
        kind: "user-input.requested",
        summary: "Questions",
        payload: {
          requestId: "req-1",
          questions: [
            {
              id: "q-1",
              header: "Branch",
              question: "Which branch?",
              options: [{ label: "main", description: "Default branch" }],
            },
          ],
        },
        turnId: null,
        createdAt: "2026-06-24T12:00:00.000Z",
      },
    ] as never);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.questions[0]?.question).toBe("Which branch?");
  });

  it("drops user-input prompts once they are resolved", () => {
    const pending = derivePendingUserInputs([
      {
        id: "event-1",
        tone: "user-input",
        kind: "user-input.requested",
        summary: "Questions",
        payload: {
          requestId: "req-1",
          questions: [
            {
              id: "q-1",
              header: "Branch",
              question: "Which branch?",
              options: [{ label: "main", description: "Default branch" }],
            },
          ],
        },
        turnId: null,
        createdAt: "2026-06-24T12:00:00.000Z",
      },
      {
        id: "event-2",
        tone: "user-input",
        kind: "user-input.resolved",
        summary: "Answered",
        payload: { requestId: "req-1" },
        turnId: null,
        createdAt: "2026-06-24T12:00:01.000Z",
      },
    ] as never);

    expect(pending).toHaveLength(0);
  });

  it("prefers the thread worktree over the project workspace root", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const thread = {
      id: "thread-1",
      projectId,
      worktreePath: "/repo/.worktrees/feature",
    } as never;
    const snapshot = {
      projects: [
        {
          id: projectId,
          title: "Project",
          workspaceRoot: "/repo",
        },
      ],
      threads: [thread],
    } as never;

    expect(resolveThreadWorkspaceRoot(snapshot, thread)).toBe("/repo/.worktrees/feature");
  });

  it("returns only built-in chat threads for the chats screen", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const snapshot = {
      snapshotSequence: 1,
      updatedAt: "2026-06-24T12:00:00.000Z",
      projects: [
        {
          id: BUILT_IN_CHATS_PROJECT_ID,
          title: "Chats",
          workspaceRoot: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-24T12:00:00.000Z",
          updatedAt: "2026-06-24T12:00:00.000Z",
          deletingAt: null,
          deletedAt: null,
        },
        {
          id: projectId,
          title: "Project",
          workspaceRoot: "/repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-24T12:00:00.000Z",
          updatedAt: "2026-06-24T12:00:00.000Z",
          deletingAt: null,
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: "chat-thread",
          projectId: BUILT_IN_CHATS_PROJECT_ID,
          title: "Chat",
          modelSelection: { provider: "codex", model: "gpt-5" },
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
          activities: [],
          checkpoints: [],
          session: null,
        },
        {
          id: "side-chat-thread",
          projectId: BUILT_IN_CHATS_PROJECT_ID,
          purpose: "side-chat",
          title: "Side chat",
          modelSelection: { provider: "codex", model: "gpt-5" },
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
          activities: [],
          checkpoints: [],
          session: null,
        },
        {
          id: "project-thread",
          projectId,
          title: "Project thread",
          modelSelection: { provider: "codex", model: "gpt-5" },
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
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    } as never;

    expect(chatThreadsForMobile(snapshot).map((thread) => thread.id)).toEqual(["chat-thread"]);
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
