import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildMobileThreadStatusInput,
  resolveMobileProviderIconClassName,
} from "./mobileThreadStatus.logic";

const threadId = ThreadId.makeUnsafe("thread-1");

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: threadId,
    projectId: "project-1",
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletingAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } as never;
}

describe("buildMobileThreadStatusInput", () => {
  it("flags pending approvals and user-input prompts from thread activities", () => {
    const input = buildMobileThreadStatusInput(
      makeThread({
        activities: [
          {
            id: "event-1",
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval",
            payload: { requestId: "req-1", requestType: "exec_command_approval" },
            turnId: null,
            createdAt: "2026-06-24T12:00:00.000Z",
          },
          {
            id: "event-2",
            tone: "user-input",
            kind: "user-input.requested",
            summary: "Questions",
            payload: {
              requestId: "req-2",
              questions: [
                {
                  id: "q-1",
                  header: "Continue",
                  question: "Continue?",
                  options: [{ label: "Yes", description: "Proceed" }],
                },
              ],
            },
            turnId: null,
            createdAt: "2026-06-24T12:00:01.000Z",
          },
        ],
      }),
    );

    expect(input.hasPendingApprovals).toBe(true);
    expect(input.hasPendingUserInput).toBe(true);
  });
});

describe("resolveMobileProviderIconClassName", () => {
  it("returns destructive styling for error sessions", () => {
    expect(
      resolveMobileProviderIconClassName(
        makeThread({
          session: {
            threadId,
            status: "error",
            providerName: null,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "boom",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    ).toBe("text-destructive");
  });

  it("returns running styling while the session is active", () => {
    expect(
      resolveMobileProviderIconClassName(
        makeThread({
          session: {
            threadId,
            status: "running",
            providerName: null,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    ).toBe("text-info-foreground");
  });
});
