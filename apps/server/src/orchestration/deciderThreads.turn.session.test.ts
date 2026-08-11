import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideThreadSessionCommand } from "./deciderThreads.turn.session.ts";

const threadId = ThreadId.makeUnsafe("thread-interrupt");
const turnId = TurnId.makeUnsafe("turn-interrupt");
const createdAt = "2026-08-11T00:00:00.000Z";

const readModel = {
  snapshotSequence: 0,
  projects: [],
  updatedAt: createdAt,
  threads: [
    {
      id: threadId,
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Interrupt",
      elevatorSummary: null,
      elevatorSummaryMessageCount: 0,
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      queuedPrompts: [{ id: MessageId.makeUnsafe("queued-1"), text: "Continue", createdAt }],
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      pinnedAt: null,
      deletingAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      tasks: [],
      activities: [],
      checkpoints: [],
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        reason: null,
        lastError: null,
        updatedAt: createdAt,
      },
      watchingThreads: [],
    },
  ],
} satisfies OrchestrationReadModel;

describe("thread.turn.interrupt", () => {
  it("persists the request to flush queued prompts after settlement", async () => {
    const event = await Effect.runPromise(
      decideThreadSessionCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("interrupt-send-now"),
          threadId,
          turnId,
          queuedPromptIdsAfterSettlement: [MessageId.makeUnsafe("queued-1")],
          createdAt,
        },
        readModel,
      }),
    );

    expect(event).toMatchObject({
      type: "thread.turn-interrupt-requested",
      payload: {
        threadId,
        turnId,
        pendingFlushIntent: {
          intentId: CommandId.makeUnsafe("interrupt-send-now"),
          requestedTurnId: turnId,
          queuedPromptIds: [MessageId.makeUnsafe("queued-1")],
          requestedAt: createdAt,
        },
      },
    });
  });
});
