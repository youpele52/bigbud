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
  it("marks the accepted start as starting before provider feedback and queues another direct start", async () => {
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
    const queued = await Effect.runPromise(
      decideThreadTurnStartCommand({
        command: command("start-second", "message-second"),
        readModel: afterStart,
      }),
    );
    expect(queued.map((event) => event.type)).toEqual(["thread.prompt-queued"]);
    expect(queued.some((event) => event.type === "thread.turn-start-requested")).toBe(false);

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

  it.each(["starting", "running", "active-turn", "approval", "user-input"] as const)(
    "queues a direct prompt for the authoritative %s busy state",
    async (state) => {
      const baseThread = readModel().threads[0]!;
      const busyThread =
        state === "starting" || state === "running"
          ? {
              ...baseThread,
              session: {
                threadId,
                status: state,
                providerName: "codex" as const,
                runtimeMode: "full-access" as const,
                activeTurnId: null,
                lastError: null,
                updatedAt: now,
              },
            }
          : state === "active-turn"
            ? {
                ...baseThread,
                session: {
                  threadId,
                  status: "ready" as const,
                  providerName: "codex" as const,
                  runtimeMode: "full-access" as const,
                  activeTurnId: "active-turn" as never,
                  lastError: null,
                  updatedAt: now,
                },
              }
            : {
                ...baseThread,
                activities: [
                  {
                    id: "pending" as never,
                    kind: state === "approval" ? "approval.requested" : "user-input.requested",
                    tone: state === "approval" ? "approval" : "info",
                    summary: "Pending interaction",
                    payload:
                      state === "approval"
                        ? { requestId: "approval" }
                        : { requestId: "input", questions: [{}] },
                    turnId: null,
                    createdAt: now,
                  },
                ],
              };
      const typedBusyThread = busyThread as OrchestrationReadModel["threads"][number];
      const events = await Effect.runPromise(
        decideThreadTurnStartCommand({
          command: command(`direct-${state}`, `message-${state}`),
          readModel: { ...readModel(), threads: [typedBusyThread] },
        }),
      );

      expect(events.map((event) => event.type)).toEqual(["thread.prompt-queued"]);
      expect(JSON.stringify(events)).not.toContain("unresolved turn");
    },
  );
});
