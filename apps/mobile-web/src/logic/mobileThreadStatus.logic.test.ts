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

  it.each([
    ["idle", "closed"],
    ["starting", "connecting"],
    ["running", "running"],
    ["ready", "ready"],
    ["interrupted", "ready"],
    ["stopped", "closed"],
    ["error", "error"],
  ] as const)("maps canonical session %s to legacy phase %s", (status, expectedPhase) => {
    const input = buildMobileThreadStatusInput(
      makeThread({
        session: {
          threadId,
          status,
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: "turn-1",
          sessionEpoch: 4,
          reason: "provider state",
          lastError: status === "error" ? "boom" : null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    expect(input.session).toMatchObject({
      provider: "claudeAgent",
      status: expectedPhase,
      orchestrationStatus: status,
      activeTurnId: "turn-1",
      sessionEpoch: 4,
      reason: "provider state",
    });
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

  it("returns completed styling for an unread successful turn", () => {
    expect(
      resolveMobileProviderIconClassName(
        makeThread({
          latestTurn: {
            turnId: "turn-1",
            state: "completed",
            assistantMessageId: null,
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:05:00.000Z",
          },
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:05:00.000Z",
          },
        }),
      ),
    ).toBe("text-success");
  });
});
