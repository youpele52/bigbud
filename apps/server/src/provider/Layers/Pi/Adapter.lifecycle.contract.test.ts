import { ThreadId, TurnId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makePiAdapterMethods } from "./Adapter.methods.ts";
import { makeHandleStdoutEvent } from "./Adapter.stream.ts";
import type { ActivePiSession, PiSyntheticEventFn } from "./Adapter.types.ts";
import { asEventId, createProviderServiceHarness } from "./Adapter.stream.test.helpers.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-pi-lifecycle-contract");
const TURN_ID = TurnId.makeUnsafe("turn-pi-lifecycle-contract");

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
  it("does not report idle before agent_end, then reports canonical idle", async () => {
    const provider = createProviderServiceHarness();
    const session = makeSession();
    const sessions = new Map([[THREAD_ID, session]]);
    let sequence = 0;
    const makeSyntheticEvent: PiSyntheticEventFn = (threadId, type, payload, extra) =>
      Effect.succeed({
        eventId: asEventId(`pi-lifecycle-${++sequence}`),
        provider: "pi",
        threadId,
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
    expect(await Effect.runPromise(methods.listSessions())).toMatchObject([
      { threadId: THREAD_ID, status: "ready" },
    ]);
  });
});
