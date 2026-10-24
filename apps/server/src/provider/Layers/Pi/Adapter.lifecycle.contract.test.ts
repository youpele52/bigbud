import { ThreadId, TurnId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makePiAdapterMethods } from "./Adapter.methods.ts";
import { makeHandleStdoutEvent } from "./Adapter.stream.ts";
import type { ActivePiSession, PiSyntheticEventFn } from "./Adapter.types.ts";
import { asEventId, createProviderServiceHarness } from "./Adapter.stream.test.helpers.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-pi-lifecycle-contract");
const TURN_ID = TurnId.makeUnsafe("turn-pi-lifecycle-contract");

const handledPrompt = async () => ({
  type: "response",
  command: "prompt",
  success: true,
  data: { disposition: "handled" },
});

function makeSession(): ActivePiSession {
  return {
    process: {
      child: {} as never,
      command: "pi",
      args: [],
      stderrTail: () => "",
      request: (async () => ({
        type: "response",
        command: "get_state",
        success: true,
        data: {},
      })) as ActivePiSession["process"]["request"],
      write: async () => undefined,
      subscribe: () => () => undefined,
      stop: async () => undefined,
    },
    threadId: THREAD_ID,
    sessionEpoch: 7,
    createdAt: "2026-08-11T00:00:00.000Z",
    runtimeMode: "full-access",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    pendingUserInputs: new Map(),
    turns: [{ id: TURN_ID, items: [] }],
    unsubscribe: () => undefined,
    cwd: undefined,
    model: undefined,
    providerID: undefined,
    thinkingLevel: undefined,
    updatedAt: "2026-08-11T00:00:00.000Z",
    lastError: undefined,
    agentRunning: true,
    activeTurnId: TURN_ID,
    queuedTurnIds: [],
    pendingTurnEnd: undefined,
    completedTurnBoundary: undefined,
    lastUsage: undefined,
    sessionId: "pi-lifecycle-contract",
    sessionFile: undefined,
    currentAssistantMessageId: undefined,
    currentToolOutputById: new Map(),
    currentToolInfoById: new Map(),
    lastPlanFingerprint: undefined,
  };
}

describe("Pi adapter lifecycle contract", () => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "waits for the terminal lifecycle event (settled: %s, disposition: %s)",
    async (modern, disposition) => {
      const provider = createProviderServiceHarness();
      const base = makeSession();
      const session: ActivePiSession = {
        ...base,
        process: {
          ...base.process,
          supportsAgentSettled: modern,
          supportsPromptDisposition: disposition,
          request: handledPrompt as ActivePiSession["process"]["request"],
        },
      };
      const sessions = new Map([[THREAD_ID, session]]);
      let sequence = 0;
      const makeSyntheticEvent: PiSyntheticEventFn = (
        threadId,
        sessionEpoch,
        type,
        payload,
        extra,
      ) =>
        Effect.succeed({
          eventId: asEventId(`pi-lifecycle-${++sequence}`),
          provider: "pi",
          threadId,
          sessionEpoch,
          createdAt: "2026-08-11T00:00:00.000Z",
          ...(extra?.turnId ? { turnId: extra.turnId } : {}),
          type,
          payload,
        } as never);
      const handleStdoutEvent = makeHandleStdoutEvent({
        emit: provider.publish,
        makeEventStamp: () =>
          Effect.succeed({
            eventId: asEventId(`pi-lifecycle-${++sequence}`),
            createdAt: "2026-08-11T00:00:00.000Z",
          }),
        makeSyntheticEvent,
        runPromise: Effect.runPromise,
        sessions,
        writeNativeEvent: () => Effect.void,
      });
      const methods = makePiAdapterMethods({
        attachmentsDir: "/tmp",
        stateDir: "/tmp",
        host: "127.0.0.1",
        port: 3773,
        emit: provider.publish,
        handleProcessExit: () => Effect.void,
        handleStdoutEvent,
        makeSyntheticEvent,
        runPromise: Effect.runPromise,
        serverSettings: { getSettings: Effect.die("unused") },
        sessions,
      });

      await Effect.runPromise(handleStdoutEvent(session, { type: "turn_end" }));
      expect(await Effect.runPromise(methods.listSessions())).toMatchObject([
        { threadId: THREAD_ID, status: "running", activeTurnId: TURN_ID },
      ]);

      await Effect.runPromise(handleStdoutEvent(session, { type: "agent_end" }));
      if (modern) {
        expect(session.activeTurnId).toBe(TURN_ID);
        expect(provider.emittedEvents.some((event) => event.type === "turn.completed")).toBe(false);
        await Effect.runPromise(handleStdoutEvent(session, { type: "agent_start" }));
        await Effect.runPromise(
          handleStdoutEvent(session, { type: "turn_end", message: { stopReason: "stop" } }),
        );
        session.queuedTurnIds.push(TurnId.makeUnsafe("queued"));
        session.pendingPromptTurnIds = new Set([TurnId.makeUnsafe("queued")]);
        await Effect.runPromise(
          handleStdoutEvent(session, {
            type: "queue_update",
            steering: ["Next task"],
            followUp: [],
          }),
        );
        await Effect.runPromise(
          handleStdoutEvent(session, {
            type: "response",
            id: "queued",
            command: "prompt",
            success: true,
            ...(disposition ? { data: { disposition: "queued" } } : {}),
          }),
        );
        await Effect.runPromise(
          handleStdoutEvent(session, { type: "queue_update", steering: [], followUp: [] }),
        );
        await Effect.runPromise(handleStdoutEvent(session, { type: "agent_end" }));
        expect(session.activeTurnId).toBe(TURN_ID);
        await Effect.runPromise(
          handleStdoutEvent(session, {
            type: "message_start",
            message: { role: "user", content: "Next task" },
          }),
        );
        expect(session.activeTurnId).toBe("queued");
        expect(session.queuedTurnIds).toEqual([]);
        await Effect.runPromise(
          handleStdoutEvent(session, { type: "agent_settled", aborted: true }),
        );
        await Effect.runPromise(
          handleStdoutEvent(session, { type: "agent_settled", aborted: true }),
        );
        expect(
          provider.emittedEvents.filter((event) => event.type === "turn.completed"),
        ).toMatchObject([
          { turnId: TURN_ID, payload: { state: "interrupted" } },
          { turnId: "queued", payload: { state: "interrupted" } },
        ]);
        expect(session.queuedTurnIds).toEqual([]);
      }
      expect(await Effect.runPromise(methods.listSessions())).toMatchObject([
        { threadId: THREAD_ID, status: "ready" },
      ]);
      expect(
        provider.emittedEvents.every((event) => event.sessionEpoch === session.sessionEpoch),
      ).toBe(true);
      const handled = await Effect.runPromise(
        methods.sendTurn({ threadId: THREAD_ID, input: "/custom-command" }),
      );
      expect(session.activeTurnId).toBeUndefined();
      expect(provider.emittedEvents).toContainEqual(
        expect.objectContaining({
          type: "turn.completed",
          turnId: handled.turnId,
          payload: { state: "completed", stopReason: "handled" },
        }),
      );
    },
  );
});
