import {
  EventId,
  type OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { Project, Thread } from "../models/types";
import { collectGlobalPendingApprovalCandidate } from "./pendingApprovalCoordinator.logic";

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
  projectId?: string;
  title?: string;
  worktreePath?: string | null;
  activities?: OrchestrationThreadActivity[];
}): Thread {
  return {
    id: ThreadId.makeUnsafe(overrides.id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe(overrides.projectId ?? "project-1"),
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
    worktreePath: overrides.worktreePath ?? null,
    turnDiffSummaries: [],
    activities: overrides.activities ?? [],
  };
}

function makeProject(overrides: { id: string; name?: string; cwd?: string | null }): Project {
  return {
    id: ProjectId.makeUnsafe(overrides.id),
    name: overrides.name ?? overrides.id,
    cwd: overrides.cwd ?? null,
    defaultModelSelection: null,
    scripts: [],
  };
}

describe("collectGlobalPendingApprovalCandidate", () => {
  it("returns null when no threads have pending approvals", () => {
    expect(
      collectGlobalPendingApprovalCandidate(
        [makeThread({ id: "thread-1" }), makeThread({ id: "thread-2" })],
        [makeProject({ id: "project-1" })],
      ),
    ).toBeNull();
  });

  it("returns the oldest actionable approval across all threads with source context", () => {
    const candidate = collectGlobalPendingApprovalCandidate(
      [
        makeThread({
          id: "thread-1",
          title: "Investigate server bug",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/server-bug",
          activities: [
            makeActivity({
              id: "approval-oldest",
              createdAt: "2026-02-23T00:00:01.000Z",
              kind: "approval.requested",
              summary: "Command approval requested",
              tone: "approval",
              payload: {
                requestId: "req-1",
                requestKind: "command",
                detail: "grep TODO src/server.ts",
              },
            }),
            makeActivity({
              id: "approval-second",
              createdAt: "2026-02-23T00:00:03.000Z",
              kind: "approval.requested",
              summary: "Command approval requested",
              tone: "approval",
              payload: {
                requestId: "req-2",
                requestKind: "command",
                detail: "cat package.json",
              },
            }),
          ],
        }),
        makeThread({
          id: "thread-2",
          title: "Review UI flow",
          projectId: "project-2",
          activities: [
            makeActivity({
              id: "approval-newer",
              createdAt: "2026-02-23T00:00:02.000Z",
              kind: "approval.requested",
              summary: "Tool approval requested",
              tone: "approval",
              payload: {
                requestId: "req-3",
                requestType: "dynamic_tool_call",
                detail: "Run a tool",
              },
            }),
          ],
        }),
      ],
      [
        makeProject({ id: "project-1", name: "Server", cwd: "/repo" }),
        makeProject({ id: "project-2", name: "Web", cwd: "/repo/web" }),
      ],
    );

    expect(candidate).toEqual({
      threadId: "thread-1",
      threadTitle: "Investigate server bug",
      projectName: "Server",
      workingDirectory: "/repo/worktrees/server-bug",
      approval: {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "grep TODO src/server.ts",
      },
      pendingCount: 3,
    });
  });

  it("ignores approvals that were already resolved", () => {
    const candidate = collectGlobalPendingApprovalCandidate(
      [
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
      ],
      [makeProject({ id: "project-1" })],
    );

    expect(candidate).toBeNull();
  });
});
