import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideThreadTurnStartCommand } from "./deciderThreads.turn.start.ts";
import { projectEvent } from "./projector.ts";
import { makeEvent } from "./projector.test.helpers.ts";

const now = "2026-08-18T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("dispatch-safety-thread");

function readModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    updatedAt: now,
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("dispatch-safety-project"),
        title: "Dispatch safety",
        elevatorSummary: null,
        elevatorSummaryMessageCount: 0,
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
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
      },
    ],
  };
}

function command(commandId: string, messageId: string) {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.makeUnsafe(commandId),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(messageId),
      role: "user" as const,
      text: "hello",
      attachments: [],
    },
    runtimeMode: "full-access" as const,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: now,
  };
}

describe("direct turn-start dispatch safety", () => {
  it("marks the accepted start as starting before provider feedback and rejects another direct start", async () => {
    const initial = readModel();
    const first = await Effect.runPromise(
      decideThreadTurnStartCommand({
        command: command("start-first", "message-first"),
        readModel: initial,
      }),
    );
    const afterMessage = await Effect.runPromise(
      projectEvent(initial, { ...first[0]!, sequence: 1 } as OrchestrationEvent),
    );
    const afterStart = await Effect.runPromise(
      projectEvent(afterMessage, { ...first[1]!, sequence: 2 } as OrchestrationEvent),
    );

    expect(afterStart.threads[0]?.session).toMatchObject({
      status: "starting",
      activeTurnId: null,
    });
    await expect(
      Effect.runPromise(
        decideThreadTurnStartCommand({
          command: command("start-second", "message-second"),
          readModel: afterStart,
        }),
      ),
    ).rejects.toThrow("has an unresolved turn");

    const afterFailure = await Effect.runPromise(
      projectEvent(
        afterStart,
        makeEvent({
          sequence: 3,
          type: "thread.turn-start-failed",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: "start-failed",
          payload: {
            threadId,
            context: "provider-turn-start",
            detail: "Provider turn start failed.",
            createdAt: now,
          },
        }),
      ),
    );
    const retry = await Effect.runPromise(
      decideThreadTurnStartCommand({
        command: command("start-retry", "message-retry"),
        readModel: afterFailure,
      }),
    );

    expect(retry.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});
