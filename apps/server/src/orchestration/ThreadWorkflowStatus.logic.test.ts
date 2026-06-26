import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveThreadWorkflowStatus,
  serializeThreadWorkflowStatusMarkdown,
} from "./ThreadWorkflowStatus.logic.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeThread(overrides: Partial<Parameters<typeof resolveThreadWorkflowStatus>[0]> = {}) {
  return {
    id: THREAD_ID,
    projectId: "project-1" as never,
    title: "Feature A",
    modelSelection: { provider: "codex" as const, model: "gpt-5" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
    ...overrides,
  };
}

describe("ThreadWorkflowStatus.logic", () => {
  it("reports working when the session is running", () => {
    const status = resolveThreadWorkflowStatus(
      makeThread({
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: "turn-1" as never,
          reason: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        latestTurn: {
          turnId: "turn-1" as never,
          state: "running",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    expect(status.workflowStatus).toBe("working");
    expect(status.isAgentActive).toBe(true);
    expect(status.isWorkflowComplete).toBe(false);
  });

  it("reports workflow_complete when the latest turn settled without blockers", () => {
    const status = resolveThreadWorkflowStatus(
      makeThread({
        session: {
          threadId: THREAD_ID,
          status: "idle",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          reason: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        latestTurn: {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:05:00.000Z",
          assistantMessageId: null,
        },
        messages: [
          {
            id: "message-1" as never,
            role: "assistant",
            text: "Feature A is done.",
            turnId: "turn-1" as never,
            streaming: false,
            createdAt: "2026-01-01T00:05:00.000Z",
            updatedAt: "2026-01-01T00:05:00.000Z",
          },
        ],
      }),
    );

    expect(status.workflowStatus).toBe("workflow_complete");
    expect(status.isWorkflowComplete).toBe(true);
    expect(status.lastAssistantExcerpt).toBe("Feature A is done.");
  });

  it("serializes workflow status for attached thread context", () => {
    const markdown = serializeThreadWorkflowStatusMarkdown(
      resolveThreadWorkflowStatus(
        makeThread({
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:05:00.000Z",
            assistantMessageId: null,
          },
        }),
      ),
    );

    expect(markdown).toContain("Workflow status:");
    expect(markdown).toContain("get_thread_status");
  });
});
