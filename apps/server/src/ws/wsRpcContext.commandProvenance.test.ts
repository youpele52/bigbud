import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { seedMessageEvent } from "../orchestration/deciderThreads.lifecycle.seed.ts";
import { verifiedOrchestraAssignmentSegments } from "../orchestration/ThreadMessageOrigin.logic.ts";
import { stripPublicProvenance } from "./wsRpcContext.commandProvenance.ts";

const projectId = ProjectId.makeUnsafe("project");
const parent = {
  id: ThreadId.makeUnsafe("parent"),
  projectId,
  title: "Parent",
  deletedAt: null,
};
const sibling = {
  ...parent,
  id: ThreadId.makeUnsafe("sibling"),
  title: "Sibling",
  parentThread: { threadId: parent.id, title: parent.title },
};

function create(
  sourceThreadId: ThreadId,
): Extract<OrchestrationCommand, { type: "thread.create" }> {
  const createdAt = "2026-09-28T12:00:00.000Z";
  return {
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`create-${sourceThreadId}`),
    threadId: ThreadId.makeUnsafe("target"),
    projectId,
    title: "Target",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    parentThread: { threadId: parent.id, title: "Claimed parent" },
    seedMessages: [
      {
        id: MessageId.makeUnsafe("seed"),
        role: "user",
        text: "Continue",
        originSegments: [
          {
            kind: "handoff",
            actor: "agent",
            text: "Continue",
            verified: true,
            sourceThreads: [{ threadId: sourceThreadId, title: "Claimed source" }],
          },
        ],
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    createdAt,
  };
}

function dispatchSeed(command: ReturnType<typeof create>, threads: unknown[]) {
  const publicCommand = stripPublicProvenance(command) as typeof command;
  return seedMessageEvent({
    command: publicCommand,
    message: publicCommand.seedMessages![0]!,
    readModel: { threads } as never,
  });
}

describe("public orchestra assignment provenance", () => {
  function assignment(sourceId: ThreadId) {
    return stripPublicProvenance({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("assignment"),
      threadId: sibling.id,
      message: {
        messageId: MessageId.makeUnsafe("assignment-message"),
        role: "user",
        text: "Implement",
        attachments: [],
        originSegments: [
          {
            kind: "orchestraAssignment",
            actor: "userAssignment",
            text: "Implement",
            verified: true,
            sourceThreads: [{ threadId: sourceId, title: "Claimed" }],
          },
        ],
      },
      modelSelection: { provider: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-09-28T12:00:00.000Z",
    }) as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
  }

  it("re-verifies a valid first assignment and rejects a spoofed public source", () => {
    const valid = assignment(parent.id);
    expect(valid.message.originSegments?.[0]?.verified).toBe(false);
    expect(
      verifiedOrchestraAssignmentSegments({
        message: valid.message,
        targetThread: { ...sibling, latestTurn: null } as never,
        readModel: { threads: [parent, sibling] } as never,
      }),
    ).toEqual([expect.objectContaining({ verified: true, text: "Implement" })]);

    const forged = assignment(ThreadId.makeUnsafe("forged"));
    expect(
      verifiedOrchestraAssignmentSegments({
        message: forged.message,
        targetThread: { ...sibling, latestTurn: null } as never,
        readModel: { threads: [parent, sibling] } as never,
      }),
    ).toBeUndefined();
  });
});

describe("public seed provenance dispatch", () => {
  it("re-verifies a valid sibling handoff server-side", () => {
    const event = dispatchSeed(create(sibling.id), [parent, sibling]);
    expect(event.payload).toMatchObject({
      originSegments: [
        {
          kind: "handoff",
          actor: "userAssignment",
          verified: true,
          sourceThreads: [{ threadId: sibling.id, title: sibling.title }],
        },
      ],
    });
  });

  it("drops a forged seed outside persisted sibling lineage", () => {
    const unrelated = { ...sibling, id: ThreadId.makeUnsafe("unrelated"), parentThread: undefined };
    const event = dispatchSeed(create(unrelated.id), [parent, unrelated]);
    expect(event.payload).not.toHaveProperty("originSegments");
  });
});
