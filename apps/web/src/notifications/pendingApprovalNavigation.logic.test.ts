import {
  EventId,
  type OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { collectLatestPendingApprovalCandidate } from "./pendingApprovalNavigation.logic";
import type { Thread } from "../models/types";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

function makeThread(overrides: {
  id: string;
  title?: string;
  activities?: OrchestrationThreadActivity[];
}): Thread {
  return {
    id: ThreadId.makeUnsafe(overrides.id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: overrides.title ?? overrides.id,
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-23T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-02-23T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: overrides.activities ?? [],
  };
}

describe("collectLatestPendingApprovalCandidate", () => {
  it("returns null when no threads have pending approvals", () => {
    expect(
      collectLatestPendingApprovalCandidate([
        makeThread({ id: "thread-1" }),
        makeThread({ id: "thread-2" }),
      ]),
    ).toBeNull();
  });

  it("returns the newest pending approval across all threads", () => {
    const candidate = collectLatestPendingApprovalCandidate([
      makeThread({
        id: "thread-1",
        activities: [
          makeActivity({
            id: "approval-old",
            createdAt: "2026-02-23T00:00:01.000Z",
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            payload: {
              requestId: "req-1",
              requestKind: "command",
              detail: "pwd",
            },
          }),
        ],
      }),
      makeThread({
        id: "thread-2",
        activities: [
          makeActivity({
            id: "approval-new",
            createdAt: "2026-02-23T00:00:02.000Z",
            kind: "approval.requested",
            summary: "Tool approval requested",
            tone: "approval",
            payload: {
              requestId: "req-2",
              requestType: "dynamic_tool_call",
              detail: "Run a tool",
            },
          }),
        ],
      }),
    ]);

    expect(candidate).toEqual({
      threadId: "thread-2",
      approval: {
        requestId: "req-2",
        requestKind: "tool",
        createdAt: "2026-02-23T00:00:02.000Z",
        detail: "Run a tool",
      },
    });
  });

  it("ignores approvals that were already resolved", () => {
    const candidate = collectLatestPendingApprovalCandidate([
      makeThread({
        id: "thread-1",
        activities: [
          makeActivity({
            id: "approval-open",
            createdAt: "2026-02-23T00:00:01.000Z",
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            payload: {
              requestId: "req-1",
              requestKind: "command",
            },
          }),
          makeActivity({
            id: "approval-resolved",
            createdAt: "2026-02-23T00:00:02.000Z",
            kind: "approval.resolved",
            summary: "Approval resolved",
            tone: "info",
            payload: {
              requestId: "req-1",
            },
          }),
        ],
      }),
    ]);

    expect(candidate).toBeNull();
  });
});
