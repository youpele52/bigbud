import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { ThreadId, TurnId } from "@bigbud/contracts";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";

import { recoverMissingPiAgentEnd } from "./Adapter.stream.missingAgentEnd.ts";
import { makeHandleStdoutEvent } from "./Adapter.stream.ts";
import type { ActivePiSession, PiSyntheticEventFn } from "./Adapter.types.ts";
import { asEventId, createProviderServiceHarness } from "./Adapter.stream.test.helpers.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-pi-missing-agent-end");
const TURN_ID = TurnId.makeUnsafe("turn-pi-missing-agent-end");
const CREATED_AT = "2026-08-11T00:00:00.000Z";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createHarness(getState: () => Promise<boolean>) {
  const provider = createProviderServiceHarness();
  const sessions = new Map<ThreadId, ActivePiSession>();
  let sequence = 0;
  const makeSyntheticEvent: PiSyntheticEventFn = (threadId, sessionEpoch, type, payload, extra) =>
    Effect.succeed({
      eventId: asEventId(`pi-missing-agent-end-${++sequence}`),
      provider: "pi",
      threadId,
      sessionEpoch,
      createdAt: CREATED_AT,
      ...(extra?.turnId ? { turnId: extra.turnId } : {}),
      type,
      payload,
    } as never);
  const session = {
    process: {
      child: {} as never,
      command: "pi",
      args: [],
      stderrTail: () => "",
      request: (async () => ({
        type: "response",
        command: "get_state",
        success: true,
        data: { isStreaming: await getState() },
      })) as ActivePiSession["process"]["request"],
      write: async () => undefined,
      subscribe: () => () => undefined,
      stop: async () => undefined,
    },
    threadId: THREAD_ID,
    sessionEpoch: 0,
    createdAt: CREATED_AT,
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
    updatedAt: CREATED_AT,
    lastError: undefined,
    agentRunning: true,
    activeTurnId: TURN_ID,
    queuedTurnIds: [],
    pendingTurnEnd: undefined,
    completedTurnBoundary: undefined,
    missingAgentEndRecoveryToken: undefined,
    lastUsage: undefined,
    sessionId: undefined,
    sessionFile: undefined,
    currentAssistantMessageId: undefined,
    currentToolOutputById: new Map(),
    currentToolInfoById: new Map(),
    lastPlanFingerprint: undefined,
  } satisfies ActivePiSession;
  sessions.set(THREAD_ID, session);
  return {
    provider,
    session,
    handle: makeHandleStdoutEvent({
      emit: provider.publish,
      makeEventStamp: () =>
        Effect.succeed({
          eventId: asEventId(`pi-missing-agent-end-${++sequence}`),
          createdAt: CREATED_AT,
        }),
      makeSyntheticEvent,
      runPromise: Effect.runPromise,
      sessions,
      writeNativeEvent: () => Effect.void,
    }),
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for Pi missing-agent_end recovery.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function terminalEvents(events: ReadonlyArray<ProviderRuntimeEvent>) {
  return events.filter(
    (event) =>
      event.type === "turn.completed" ||
      (event.type === "session.state.changed" && event.payload.state === "ready"),
  );
}

describe("Pi adapter missing agent_end recovery", () => {
  it("reports once after all streaming recovery probes while retaining the active turn", async () => {
    let queries = 0;
    const harness = createHarness(async () => {
      queries += 1;
      return true;
    });
    harness.session.completedTurnBoundary = {} as never;
    const reports: string[] = [];
    let settlements = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* recoverMissingPiAgentEnd({
            session: harness.session,
            settle: () => Effect.sync(() => (settlements += 1)).pipe(Effect.asVoid),
            reportExhausted: (recovery) =>
              Effect.sync(() => reports.push(recovery.class)).pipe(Effect.asVoid),
          });
          yield* Effect.yieldNow;
          yield* TestClock.adjust("400 millis");
          yield* Effect.yieldNow;
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    expect(queries).toBe(4);
    expect(reports).toEqual(["missing_agent_end_recovery_exhausted"]);
    expect(settlements).toBe(0);
    expect(harness.session.activeTurnId).toBe(TURN_ID);
  });

  it("settles without reporting when a transient state query failure is followed by idle", async () => {
    let queries = 0;
    const harness = createHarness(async () => {
      queries += 1;
      if (queries === 1) throw new Error("transient state query failure");
      return false;
    });
    harness.session.completedTurnBoundary = {} as never;
    const reports: string[] = [];
    let settlements = 0;

    vi.useFakeTimers();
    try {
      await Effect.runPromise(
        Effect.scoped(
          recoverMissingPiAgentEnd({
            session: harness.session,
            settle: () => Effect.sync(() => (settlements += 1)).pipe(Effect.asVoid),
            reportExhausted: (recovery) =>
              Effect.sync(() => reports.push(recovery.class)).pipe(Effect.asVoid),
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(400);
    } finally {
      vi.useRealTimers();
    }

    expect(queries).toBe(2);
    expect(reports).toEqual([]);
    expect(settlements).toBe(1);
  });

  it("reports state query failure after every recovery probe fails", async () => {
    let queries = 0;
    const harness = createHarness(async () => {
      queries += 1;
      throw new Error("state query failed");
    });
    harness.session.completedTurnBoundary = {} as never;
    const reports: string[] = [];
    let settlements = 0;

    vi.useFakeTimers();
    try {
      await Effect.runPromise(
        Effect.scoped(
          recoverMissingPiAgentEnd({
            session: harness.session,
            settle: () => Effect.sync(() => (settlements += 1)).pipe(Effect.asVoid),
            reportExhausted: (recovery) =>
              Effect.sync(() => reports.push(recovery.class)).pipe(Effect.asVoid),
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(400);
    } finally {
      vi.useRealTimers();
    }

    expect(queries).toBe(4);
    expect(reports).toEqual(["state_query_failed"]);
    expect(settlements).toBe(0);
  });

  it("does not query or settle again after recovery is invalidated mid-probe", async () => {
    const state = deferred<boolean>();
    let queries = 0;
    const harness = createHarness(async () => {
      queries += 1;
      return state.promise;
    });
    harness.session.completedTurnBoundary = {} as never;
    const reports: string[] = [];
    let settlements = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* recoverMissingPiAgentEnd({
            session: harness.session,
            settle: () => Effect.sync(() => (settlements += 1)).pipe(Effect.asVoid),
            reportExhausted: (recovery) =>
              Effect.sync(() => reports.push(recovery.class)).pipe(Effect.asVoid),
          });
          yield* Effect.yieldNow;
          harness.session.missingAgentEndRecoveryToken = undefined;
          state.resolve(false);
          yield* Effect.yieldNow;
          yield* TestClock.adjust("400 millis");
          yield* Effect.yieldNow;
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    expect(queries).toBe(1);
    expect(reports).toEqual([]);
    expect(settlements).toBe(0);
  });

  it("settles a completed turn from authoritative idle process state", async () => {
    const harness = createHarness(async () => false);

    await Effect.runPromise(
      harness.handle(harness.session, { type: "turn_end", message: { stopReason: "completed" } }),
    );
    await waitFor(() => terminalEvents(harness.provider.emittedEvents).length === 2);

    expect(harness.session.activeTurnId).toBeUndefined();
    expect(terminalEvents(harness.provider.emittedEvents).map((event) => event.type)).toEqual([
      "turn.completed",
      "session.state.changed",
    ]);
  });

  it("does not settle when a late agent_end or new activity supersedes recovery", async () => {
    const lateEnd = deferred<boolean>();
    const lateEndHarness = createHarness(() => lateEnd.promise);
    await Effect.runPromise(lateEndHarness.handle(lateEndHarness.session, { type: "turn_end" }));
    await Effect.runPromise(lateEndHarness.handle(lateEndHarness.session, { type: "agent_end" }));
    lateEnd.resolve(false);
    await waitFor(() => terminalEvents(lateEndHarness.provider.emittedEvents).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminalEvents(lateEndHarness.provider.emittedEvents)).toHaveLength(2);

    const newActivity = deferred<boolean>();
    const newActivityHarness = createHarness(() => newActivity.promise);
    await Effect.runPromise(
      newActivityHarness.handle(newActivityHarness.session, { type: "turn_end" }),
    );
    await Effect.runPromise(
      newActivityHarness.handle(newActivityHarness.session, { type: "agent_start" }),
    );
    newActivity.resolve(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminalEvents(newActivityHarness.provider.emittedEvents)).toHaveLength(0);
    expect(newActivityHarness.session.activeTurnId).toBe(TURN_ID);
  });

  it("treats duplicate terminal signals idempotently", async () => {
    const harness = createHarness(async () => false);

    await Effect.runPromise(harness.handle(harness.session, { type: "turn_end" }));
    await Effect.runPromise(harness.handle(harness.session, { type: "turn_end" }));
    await Effect.runPromise(harness.handle(harness.session, { type: "agent_end" }));
    await Effect.runPromise(harness.handle(harness.session, { type: "agent_end" }));
    await waitFor(() => terminalEvents(harness.provider.emittedEvents).length === 2);

    expect(terminalEvents(harness.provider.emittedEvents)).toHaveLength(2);
  });
});
