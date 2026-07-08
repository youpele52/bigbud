import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeHandleStdoutEvent } from "./Adapter.stream.ts";
import type { ActivePiSession, PiSyntheticEventFn } from "./Adapter.types.ts";
import {
  asEventId,
  asThreadId,
  asTurnId,
  createProviderServiceHarness,
} from "./Adapter.stream.test.helpers.ts";

describe("PiAdapter stream ingestion — turn deferral", () => {
  it("defers Pi turn completion until an open assistant message ends", async () => {
    const createdAt = "2026-05-12T12:00:00.000Z";
    const provider = createProviderServiceHarness();
    let eventSequence = 0;
    const sessions = new Map<ThreadId, ActivePiSession>();
    const makeSyntheticEvent: PiSyntheticEventFn = (threadId, type, payload, extra) =>
      Effect.succeed({
        eventId: asEventId(`synthetic-${++eventSequence}`),
        provider: "pi",
        threadId,
        createdAt,
        ...(extra?.turnId ? { turnId: extra.turnId } : {}),
        ...(extra?.itemId ? { itemId: extra.itemId as never } : {}),
        ...(extra?.requestId ? { requestId: extra.requestId as never } : {}),
        type,
        payload,
      } as unknown as Extract<ProviderRuntimeEvent, { type: typeof type }>);
    const handleStdoutEvent = makeHandleStdoutEvent({
      emit: provider.publish,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: asEventId(`pi-runtime-${++eventSequence}`),
          createdAt,
        }),
      makeSyntheticEvent,
      runPromise: Effect.runPromise,
      sessions,
      writeNativeEvent: () => Effect.void,
    });
    const session: ActivePiSession = {
      process: {
        child: {} as never,
        command: "pi",
        args: [],
        stderrTail: () => "",
        request: async () => {
          throw new Error("unused");
        },
        write: async () => undefined,
        subscribe: () => () => undefined,
        stop: async () => undefined,
      },
      threadId: asThreadId("thread-1"),
      createdAt,
      runtimeMode: "approval-required",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      pendingUserInputs: new Map(),
      turns: [{ id: asTurnId("turn-pi"), items: [] }],
      unsubscribe: () => undefined,
      cwd: undefined,
      model: "sonnet",
      providerID: "anthropic",
      thinkingLevel: undefined,
      updatedAt: createdAt,
      lastError: undefined,
      agentRunning: true,
      activeTurnId: asTurnId("turn-pi"),
      queuedTurnIds: [],
      pendingTurnEnd: undefined,
      completedTurnBoundary: undefined,
      lastUsage: undefined,
      sessionId: "pi-session-1",
      sessionFile: undefined,
      currentAssistantMessageId: undefined,
      currentToolOutputById: new Map(),
      currentToolInfoById: new Map(),
      lastPlanFingerprint: undefined,
    };
    sessions.set(session.threadId, session);

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "message_start",
        message: { role: "assistant" },
      }),
    );
    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "turn_end",
        message: { stopReason: "completed" },
      }),
    );

    expect(session.activeTurnId).toBe(asTurnId("turn-pi"));
    expect(session.pendingTurnEnd).toBeDefined();
    expect(provider.emittedEvents.some((event) => event.type === "turn.completed")).toBe(false);
    expect(
      provider.emittedEvents.some(
        (event) => event.type === "session.state.changed" && event.payload.state === "ready",
      ),
    ).toBe(false);

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "still streaming",
        },
      }),
    );
    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "still streaming" }],
        },
      }),
    );

    expect(session.activeTurnId).toBe(asTurnId("turn-pi"));
    expect(session.pendingTurnEnd).toBeUndefined();
    expect(session.completedTurnBoundary).toBeDefined();
    expect(provider.emittedEvents.map((event) => event.type)).toContain("item.completed");
    expect(provider.emittedEvents.map((event) => event.type)).not.toContain("turn.completed");
    expect(
      provider.emittedEvents.some(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.state === "running" &&
          event.payload.reason === "turn.completed.awaiting_agent_end",
      ),
    ).toBe(true);

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "agent_end",
      }),
    );

    expect(session.activeTurnId).toBeUndefined();
    expect(session.completedTurnBoundary).toBeUndefined();
    expect(provider.emittedEvents.some((event) => event.type === "turn.completed")).toBe(true);
    expect(
      provider.emittedEvents.some(
        (event) => event.type === "session.state.changed" && event.payload.state === "ready",
      ),
    ).toBe(true);
  });
});

describe("PiAdapter stream ingestion — turn queuing", () => {
  it("promotes the next queued Pi turn after the current turn completes", async () => {
    const createdAt = "2026-05-12T12:00:00.000Z";
    const provider = createProviderServiceHarness();
    let eventSequence = 0;
    const sessions = new Map<ThreadId, ActivePiSession>();
    const makeSyntheticEvent: PiSyntheticEventFn = (threadId, type, payload, extra) =>
      Effect.succeed({
        eventId: asEventId(`synthetic-${++eventSequence}`),
        provider: "pi",
        threadId,
        createdAt,
        ...(extra?.turnId ? { turnId: extra.turnId } : {}),
        ...(extra?.itemId ? { itemId: extra.itemId as never } : {}),
        ...(extra?.requestId ? { requestId: extra.requestId as never } : {}),
        type,
        payload,
      } as unknown as Extract<ProviderRuntimeEvent, { type: typeof type }>);
    const handleStdoutEvent = makeHandleStdoutEvent({
      emit: provider.publish,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: asEventId(`pi-runtime-${++eventSequence}`),
          createdAt,
        }),
      makeSyntheticEvent,
      runPromise: Effect.runPromise,
      sessions,
      writeNativeEvent: () => Effect.void,
    });
    const session: ActivePiSession = {
      process: {
        child: {} as never,
        command: "pi",
        args: [],
        stderrTail: () => "",
        request: async () => {
          throw new Error("unused");
        },
        write: async () => undefined,
        subscribe: () => () => undefined,
        stop: async () => undefined,
      },
      threadId: asThreadId("thread-queued"),
      createdAt,
      runtimeMode: "approval-required",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      pendingUserInputs: new Map(),
      turns: [
        { id: asTurnId("turn-current"), items: [] },
        { id: asTurnId("turn-next"), items: [] },
      ],
      unsubscribe: () => undefined,
      cwd: undefined,
      model: "sonnet",
      providerID: "anthropic",
      thinkingLevel: undefined,
      updatedAt: createdAt,
      lastError: undefined,
      agentRunning: true,
      activeTurnId: asTurnId("turn-current"),
      queuedTurnIds: [asTurnId("turn-next")],
      pendingTurnEnd: undefined,
      completedTurnBoundary: undefined,
      lastUsage: undefined,
      sessionId: "pi-session-1",
      sessionFile: undefined,
      currentAssistantMessageId: undefined,
      currentToolOutputById: new Map(),
      currentToolInfoById: new Map(),
      lastPlanFingerprint: undefined,
    };
    sessions.set(session.threadId, session);

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "turn_end",
        message: { stopReason: "completed" },
      }),
    );

    expect(session.activeTurnId).toBe(asTurnId("turn-current"));
    expect(session.queuedTurnIds).toEqual([asTurnId("turn-next")]);
    expect(
      provider.emittedEvents.some(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.state === "running" &&
          event.payload.reason === "turn.completed.awaiting_agent_end",
      ),
    ).toBe(true);

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "agent_end",
      }),
    );

    expect(session.activeTurnId).toBe(asTurnId("turn-next"));
    expect(session.queuedTurnIds).toHaveLength(0);
    expect(
      provider.emittedEvents.some(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.state === "running" &&
          event.payload.reason === "turn.queued",
      ),
    ).toBe(true);
  });
});

describe("PiAdapter stream ingestion — plan tracking", () => {
  it("maps update_plan tool executions to turn.plan.updated and suppresses duplicate tool spam", async () => {
    const createdAt = "2026-05-12T12:00:00.000Z";
    const provider = createProviderServiceHarness();
    let eventSequence = 0;
    const sessions = new Map<ThreadId, ActivePiSession>();
    const makeSyntheticEvent: PiSyntheticEventFn = (threadId, type, payload, extra) =>
      Effect.succeed({
        eventId: asEventId(`synthetic-${++eventSequence}`),
        provider: "pi",
        threadId,
        createdAt,
        ...(extra?.turnId ? { turnId: extra.turnId } : {}),
        ...(extra?.itemId ? { itemId: extra.itemId as never } : {}),
        ...(extra?.requestId ? { requestId: extra.requestId as never } : {}),
        type,
        payload,
      } as unknown as Extract<ProviderRuntimeEvent, { type: typeof type }>);
    const handleStdoutEvent = makeHandleStdoutEvent({
      emit: provider.publish,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: asEventId(`pi-runtime-${++eventSequence}`),
          createdAt,
        }),
      makeSyntheticEvent,
      runPromise: Effect.runPromise,
      sessions,
      writeNativeEvent: () => Effect.void,
    });
    const session: ActivePiSession = {
      process: {
        child: {} as never,
        command: "pi",
        args: [],
        stderrTail: () => "",
        request: async () => {
          throw new Error("unused");
        },
        write: async () => undefined,
        subscribe: () => () => undefined,
        stop: async () => undefined,
      },
      threadId: asThreadId("thread-plan"),
      createdAt,
      runtimeMode: "approval-required",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      pendingUserInputs: new Map(),
      turns: [{ id: asTurnId("turn-plan"), items: [] }],
      unsubscribe: () => undefined,
      cwd: undefined,
      model: "sonnet",
      providerID: "anthropic",
      thinkingLevel: undefined,
      updatedAt: createdAt,
      lastError: undefined,
      agentRunning: true,
      activeTurnId: asTurnId("turn-plan"),
      queuedTurnIds: [],
      pendingTurnEnd: undefined,
      completedTurnBoundary: undefined,
      lastUsage: undefined,
      sessionId: "pi-session-1",
      sessionFile: undefined,
      currentAssistantMessageId: undefined,
      currentToolOutputById: new Map(),
      currentToolInfoById: new Map(),
      lastPlanFingerprint: undefined,
    };
    sessions.set(session.threadId, session);

    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "tool_execution_start",
        toolCallId: "tool-call-1",
        toolName: "update_plan",
        args: {
          explanation: "Plan in progress",
          plan: [{ step: "Inspect the repo", status: "inProgress" }],
        },
      }),
    );
    await Effect.runPromise(
      handleStdoutEvent(session, {
        type: "tool_execution_start",
        toolCallId: "tool-call-2",
        toolName: "update_plan",
        args: {
          explanation: "Plan in progress",
          plan: [{ step: "Inspect the repo", status: "inProgress" }],
        },
      }),
    );

    const planEvents = provider.emittedEvents.filter((event) => event.type === "turn.plan.updated");
    expect(planEvents).toHaveLength(1);
    expect(planEvents[0]).toMatchObject({
      threadId: "thread-plan",
      turnId: "turn-plan",
      payload: {
        explanation: "Plan in progress",
        plan: [{ step: "Inspect the repo", status: "inProgress" }],
      },
    });
    expect(provider.emittedEvents.some((event) => event.type === "item.started")).toBe(false);
  });
});
