import { Effect } from "effect";
import { EventId, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";

import { mapEvent, type MapEventDeps } from "./Adapter.mapEvent.ts";
import type { ActiveCopilotSession } from "./Adapter.types.ts";

const eventId = (value: string) => EventId.makeUnsafe(value);
const threadId = (value: string) => ThreadId.makeUnsafe(value);
const turnId = (value: string) => TurnId.makeUnsafe(value);

function makeDeps(): MapEventDeps {
  return {
    makeEventStamp: () =>
      Effect.succeed({
        eventId: eventId("evt-stamp"),
        createdAt: "2026-05-14T00:00:00.000Z",
      }),
    nextEventId: Effect.succeed(eventId("evt-next")),
    emit: vi.fn(() => Effect.void),
  };
}

function makeSession(): ActiveCopilotSession {
  return {
    threadId: threadId("thread-1"),
    createdAt: "2026-05-14T00:00:00.000Z",
    runtimeMode: "approval-required",
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    renewSession: async () => {
      throw new Error("not used in test");
    },
    unsubscribe: () => undefined,
    updatedAt: "2026-05-14T00:00:00.000Z",
    activeTurnId: turnId("turn-1"),
    activeMessageId: undefined,
    lastUsage: undefined,
    stopped: false,
    lastError: undefined,
    cwd: undefined,
    model: "gpt-5",
    client: {} as ActiveCopilotSession["client"],
    session: {} as ActiveCopilotSession["session"],
  };
}

describe("CopilotAdapter.mapEvent", () => {
  it("maps assistant.reasoning_delta to a reasoning_text content delta", async () => {
    const events = await Effect.runPromise(
      mapEvent(makeDeps(), makeSession(), {
        type: "assistant.reasoning_delta",
        id: "sdk-event-1",
        parentId: null,
        timestamp: "2026-05-14T00:00:01.000Z",
        ephemeral: true,
        data: {
          reasoningId: "reasoning-1",
          deltaContent: "analyzing",
        },
      } as SessionEvent),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "content.delta",
      provider: "copilot",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      payload: {
        streamKind: "reasoning_text",
        delta: "analyzing",
      },
    });
  });

  it("maps assistant.reasoning to an item.completed event", async () => {
    const events = await Effect.runPromise(
      mapEvent(makeDeps(), makeSession(), {
        type: "assistant.reasoning",
        id: "sdk-event-2",
        parentId: null,
        timestamp: "2026-05-14T00:00:02.000Z",
        data: {
          reasoningId: "reasoning-2",
          content: "final reasoning block",
        },
      } as SessionEvent),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.completed",
      provider: "copilot",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-2",
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Assistant reasoning",
        detail: "final reasoning block",
      },
    });
  });

  it("maps session.idle to turn.completed with the active turnId (not undefined)", async () => {
    const events = await Effect.runPromise(
      mapEvent(makeDeps(), makeSession(), {
        type: "session.idle",
        id: "sdk-event-3",
        parentId: null,
        timestamp: "2026-05-14T00:00:03.000Z",
        data: { aborted: false },
      } as SessionEvent),
    );

    // turn.completed must carry the turnId that was active when idle fired;
    // the Adapter.ts event loop must NOT clear activeTurnId before calling mapEvent.
    const turnCompleted = events.find((e) => e.type === "turn.completed");
    expect(turnCompleted).toBeDefined();
    expect(turnCompleted).toMatchObject({
      type: "turn.completed",
      provider: "copilot",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: { state: "completed" },
    });
  });

  it("maps abort to turn.aborted with the active turnId (not undefined)", async () => {
    const events = await Effect.runPromise(
      mapEvent(makeDeps(), makeSession(), {
        type: "abort",
        id: "sdk-event-4",
        parentId: null,
        timestamp: "2026-05-14T00:00:04.000Z",
        data: { reason: "user_cancelled" },
      } as SessionEvent),
    );

    const turnAborted = events.find((e) => e.type === "turn.aborted");
    expect(turnAborted).toBeDefined();
    expect(turnAborted).toMatchObject({
      type: "turn.aborted",
      provider: "copilot",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: { reason: "user_cancelled" },
    });
  });
});
