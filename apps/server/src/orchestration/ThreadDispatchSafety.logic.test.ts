import { ProjectId, ThreadId, TurnId, type OrchestrationThread } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  hasActiveThreadTurnOrSession,
  isThreadConfirmedIdleForDispatch,
  isThreadTurnDispatchBlocked,
} from "./ThreadDispatchSafety.logic.ts";

const now = "2026-08-13T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("dispatch-safety-thread");

function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.makeUnsafe("dispatch-safety-project"),
    title: "Dispatch safety",
    elevatorSummary: null,
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    queuedPrompts: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    tasks: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
    ...overrides,
  } as OrchestrationThread;
}

function session(status: "starting" | "running" | "ready" | "error" | "stopped") {
  return {
    threadId,
    status,
    providerName: "codex" as const,
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    reason: null,
    lastError: null,
    updatedAt: now,
  };
}

describe("thread dispatch safety", () => {
  it.each([null, session("ready"), session("error"), session("stopped")])(
    "treats a terminal or absent session as confirmed idle",
    (value) => {
      const candidate = thread({ session: value });
      expect(hasActiveThreadTurnOrSession(candidate)).toBe(false);
      expect(isThreadConfirmedIdleForDispatch(candidate)).toBe(true);
    },
  );

  it.each(["ready", "error", "stopped"] as const)(
    "blocks any session status when an active turn is preserved",
    (status) => {
      const candidate = thread({
        session: { ...session(status), activeTurnId: TurnId.makeUnsafe(`turn-${status}`) },
      });
      expect(hasActiveThreadTurnOrSession(candidate)).toBe(true);
      expect(isThreadTurnDispatchBlocked(candidate)).toBe(true);
    },
  );

  it.each(["starting", "running"] as const)(
    "blocks %s sessions without an active turn id",
    (status) => {
      expect(isThreadTurnDispatchBlocked(thread({ session: session(status) }))).toBe(true);
    },
  );

  it.each(["approval.requested", "user-input.requested"] as const)(
    "blocks pending %s interactions",
    (kind) => {
      expect(
        isThreadTurnDispatchBlocked(
          thread({
            activities: [
              {
                id: "pending" as never,
                kind,
                tone: kind === "approval.requested" ? "approval" : "info",
                summary: "Pending interaction",
                createdAt: now,
                turnId: null,
                payload:
                  kind === "approval.requested"
                    ? { requestId: "approval" }
                    : { requestId: "input", questions: [{}] },
              },
            ],
          }),
        ),
      ).toBe(true);
    },
  );

  it.each([
    "provider.checking",
    "provider.recovering",
    "provider.stalled",
    "provider.lost-session",
  ])("blocks health-unconfirmed state %s with its active turn preserved", (reason) => {
    expect(
      isThreadConfirmedIdleForDispatch(
        thread({
          session: {
            ...session("error"),
            activeTurnId: TurnId.makeUnsafe("unconfirmed-turn"),
            reason,
          },
        }),
      ),
    ).toBe(false);
  });
});
