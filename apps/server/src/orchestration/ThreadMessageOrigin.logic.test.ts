import { MessageId, ProjectId, ThreadId, type OrchestrationMessage } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  verifiedOrchestraAssignmentSegments,
  verifiedSeedOriginSegments,
} from "./ThreadMessageOrigin.logic.ts";

const source = {
  id: ThreadId.makeUnsafe("source"),
  projectId: ProjectId.makeUnsafe("project"),
  title: "Trusted source",
  deletedAt: null,
};
const message: OrchestrationMessage = {
  id: MessageId.makeUnsafe("seed"),
  role: "user",
  text: "Continue",
  originSegments: [
    {
      kind: "handoff",
      actor: "agent",
      text: "Continue",
      sourceThreads: [{ threadId: source.id, title: "Spoofed title" }],
      verified: false,
    },
  ],
  turnId: null,
  streaming: false,
  createdAt: "2026-09-28T12:00:00.000Z",
  updatedAt: "2026-09-28T12:00:00.000Z",
};

describe("verifiedOrchestraAssignmentSegments", () => {
  const assignmentMessage = {
    text: "Implement the task",
    originSegments: [
      {
        kind: "orchestraAssignment" as const,
        actor: "userAssignment" as const,
        text: "claimed",
        sourceThreads: [{ threadId: source.id, title: "Spoofed title" }],
        verified: false,
      },
    ],
  };

  it("verifies a first-turn child assignment from persisted parent lineage", () => {
    const child = {
      ...source,
      id: ThreadId.makeUnsafe("child"),
      parentThread: { threadId: source.id, title: source.title },
      latestTurn: null,
    };
    expect(
      verifiedOrchestraAssignmentSegments({
        message: assignmentMessage,
        targetThread: child as never,
        readModel: { threads: [source, child] } as never,
      }),
    ).toEqual([
      {
        kind: "orchestraAssignment",
        actor: "userAssignment",
        text: assignmentMessage.text,
        verified: true,
        sourceThreads: [{ threadId: source.id, title: source.title }],
      },
    ]);
  });

  it("rejects a spoofed parent and a non-first turn", () => {
    const child = {
      ...source,
      id: ThreadId.makeUnsafe("child"),
      parentThread: { threadId: ThreadId.makeUnsafe("other"), title: "Other" },
      latestTurn: null,
    };
    expect(
      verifiedOrchestraAssignmentSegments({
        message: assignmentMessage,
        targetThread: child as never,
        readModel: { threads: [source, child] } as never,
      }),
    ).toBeUndefined();
    expect(
      verifiedOrchestraAssignmentSegments({
        message: assignmentMessage,
        targetThread: {
          ...child,
          parentThread: { threadId: source.id, title: source.title },
          latestTurn: { state: "completed" },
        } as never,
        readModel: { threads: [source, child] } as never,
      }),
    ).toBeUndefined();
  });
});

describe("verifiedSeedOriginSegments", () => {
  it("verifies lineage and replaces the claimed title with server state", () => {
    expect(
      verifiedSeedOriginSegments({
        message,
        parentThread: { threadId: source.id, title: source.title },
        projectId: source.projectId,
        readModel: { threads: [source] } as never,
      }),
    ).toEqual([
      {
        kind: "handoff",
        actor: "agent",
        text: "Continue",
        sourceThreads: [{ threadId: source.id, title: source.title }],
        verified: true,
      },
    ]);
  });

  it("verifies a sibling handoff through server-known parent lineage", () => {
    const parent = { ...source, id: ThreadId.makeUnsafe("parent") };
    const sibling = { ...source, parentThread: { threadId: parent.id, title: parent.title } };
    expect(
      verifiedSeedOriginSegments({
        message,
        parentThread: { threadId: parent.id, title: parent.title },
        projectId: source.projectId,
        readModel: { threads: [parent, sibling] } as never,
      }),
    ).toEqual([
      expect.objectContaining({
        verified: true,
        sourceThreads: [{ threadId: sibling.id, title: sibling.title }],
      }),
    ]);
  });

  it("drops a source whose asserted parent is not backed by server lineage", () => {
    const parent = { ...source, id: ThreadId.makeUnsafe("other"), title: "Other" };
    expect(
      verifiedSeedOriginSegments({
        message,
        parentThread: { threadId: parent.id, title: parent.title },
        projectId: source.projectId,
        readModel: { threads: [source, parent] } as never,
      }),
    ).toBeUndefined();
  });
});
