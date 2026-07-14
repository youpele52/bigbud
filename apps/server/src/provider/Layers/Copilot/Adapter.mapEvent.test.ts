import { Effect } from "effect";
import { EventId, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";

import { BIGBUD_PLAN_TRACKING_TOOL_NAME } from "../../../orchestration-tools/threadPlanTrackingTool.shared.ts";
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
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
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
    planTrackingToolCallIds: new Set(),
    lastPlanFingerprint: undefined,
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

  it("maps assistant usage to canonical turn accounting", async () => {
    const events = await Effect.runPromise(
      mapEvent(makeDeps(), makeSession(), {
        type: "assistant.usage",
        id: "sdk-usage-1",
        parentId: null,
        timestamp: "2026-05-14T00:00:02.000Z",
        data: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
        },
      } as SessionEvent),
    );

    expect(events[0]).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        accounting: {
          scope: "turn",
          scopeId: "turn-1",
          processedTokens: 150,
          inputTokens: 100,
          cachedInputTokens: 30,
          outputTokens: 20,
        },
      },
    });
  });

  it("maps abort to turn.aborted with the active turnId (not undefined)", async () => {
    const events = await Effect.runPromise(
      mapEvent(makeDeps(), makeSession(), {
        type: "abort",
        id: "sdk-event-4",
        parentId: null,
        timestamp: "2026-05-14T00:00:04.000Z",
        data: { reason: "user_initiated" },
      } as SessionEvent),
    );

    const turnAborted = events.find((e) => e.type === "turn.aborted");
    expect(turnAborted).toBeDefined();
    expect(turnAborted).toMatchObject({
      type: "turn.aborted",
      provider: "copilot",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: { reason: "user_initiated" },
    });
  });

  it("ignores native user_input.requested events because the callback path is authoritative", async () => {
    const events = await Effect.runPromise(
      mapEvent(makeDeps(), makeSession(), {
        type: "user_input.requested",
        id: "sdk-event-5",
        parentId: null,
        timestamp: "2026-05-14T00:00:05.000Z",
        data: {
          requestId: "sdk-request-1",
          question: "Which remote do you mean?",
          choices: ["origin", "upstream"],
        },
      } as SessionEvent),
    );

    expect(events).toEqual([]);
  });

  it("ignores native user_input.completed events because the callback path resolves the request", async () => {
    const events = await Effect.runPromise(
      mapEvent(makeDeps(), makeSession(), {
        type: "user_input.completed",
        id: "sdk-event-6",
        parentId: null,
        timestamp: "2026-05-14T00:00:06.000Z",
        data: {
          requestId: "sdk-request-1",
          answer: "origin",
        },
      } as SessionEvent),
    );

    expect(events).toEqual([]);
  });

  it("maps update_plan tool executions to turn.plan.updated and dedupes repeats", async () => {
    const session = makeSession();

    const firstEvents = await Effect.runPromise(
      mapEvent(makeDeps(), session, {
        type: "tool.execution_start",
        id: "sdk-event-7",
        parentId: null,
        timestamp: "2026-05-14T00:00:07.000Z",
        data: {
          toolCallId: "tool-call-1",
          toolName: BIGBUD_PLAN_TRACKING_TOOL_NAME,
          arguments: {
            explanation: "Working plan",
            plan: [{ step: "Inspect the repo", status: "inProgress" }],
          },
        },
      } as SessionEvent),
    );

    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]).toMatchObject({
      type: "turn.plan.updated",
      provider: "copilot",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Working plan",
        plan: [{ step: "Inspect the repo", status: "inProgress" }],
      },
    });

    const repeatedEvents = await Effect.runPromise(
      mapEvent(makeDeps(), session, {
        type: "tool.execution_start",
        id: "sdk-event-8",
        parentId: null,
        timestamp: "2026-05-14T00:00:08.000Z",
        data: {
          toolCallId: "tool-call-2",
          toolName: BIGBUD_PLAN_TRACKING_TOOL_NAME,
          arguments: {
            explanation: "Working plan",
            plan: [{ step: "Inspect the repo", status: "inProgress" }],
          },
        },
      } as SessionEvent),
    );

    expect(repeatedEvents).toEqual([]);
  });
});
