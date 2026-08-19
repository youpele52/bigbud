import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Effect, ServiceMap } from "effect";
import { describe, expect, it } from "vitest";

import { startEventStream } from "./Adapter.stream.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

const THREAD_ID = ThreadId.makeUnsafe("opencode-stream-recovery-thread");
const TURN_ID = TurnId.makeUnsafe("opencode-stream-recovery-turn");

function session(client: unknown): ActiveOpencodeSession {
  return {
    client: client as never,
    releaseServer() {},
    opencodeSessionId: "opencode-stream-recovery-session",
    threadId: THREAD_ID,
    createdAt: "2026-08-18T00:00:00.000Z",
    runtimeMode: "full-access",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    pendingPermissions: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    sseAbortController: null,
    cwd: undefined,
    model: undefined,
    providerID: undefined,
    updatedAt: "2026-08-18T00:00:00.000Z",
    lastError: undefined,
    activeTurnId: TURN_ID,
    lastUsage: undefined,
    wasRetrying: false,
    reasoningPartIds: new Set(),
    allowedTools: {},
  };
}

function event(): OpencodeEvent {
  return {
    id: "event-1",
    type: "session.updated",
    properties: { sessionID: "opencode-stream-recovery-session" },
  } as OpencodeEvent;
}

function eofStream(): AsyncIterable<never> {
  return { async *[Symbol.asyncIterator]() {} };
}

function runtimeEvent(
  type: string,
  payload: unknown,
  extra?: { readonly turnId?: TurnId },
): ProviderRuntimeEvent {
  return {
    eventId: EventId.makeUnsafe("opencode-stream-recovery-event"),
    provider: "opencode",
    threadId: THREAD_ID,
    createdAt: "2026-08-18T00:00:00.000Z",
    type,
    ...(extra?.turnId ? { turnId: extra.turnId } : {}),
    payload,
  } as never;
}

const makeSyntheticEvent = ((
  _threadId: ThreadId,
  type: string,
  payload: unknown,
  extra?: { readonly turnId?: TurnId },
) => Effect.succeed(runtimeEvent(type, payload, extra))) as never;

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  assertion();
}

describe("OpenCode SSE recovery", () => {
  it("preserves the active turn and emits one typed health event after bounded EOF recovery", async () => {
    let subscriptions = 0;
    let reconciliations = 0;
    let sessionCreates = 0;
    const emitted: ProviderRuntimeEvent[] = [];
    const record = session({
      event: {
        subscribe: async () => {
          subscriptions += 1;
          return { stream: eofStream() };
        },
      },
      session: {
        create: async () => {
          sessionCreates += 1;
          throw new Error("recovery must not create a session");
        },
      },
    });
    const owner = startEventStream(
      record,
      () => Effect.void,
      makeSyntheticEvent,
      (events) => Effect.sync(() => void emitted.push(...events)),
      ServiceMap.empty(),
      async () => void (reconciliations += 1),
      { retryDelays: [0, 0, 0], random: () => 0 },
    );
    await eventually(() => expect(emitted).toHaveLength(1));
    expect(subscriptions).toBe(4);
    expect(reconciliations).toBeGreaterThan(0);
    expect(sessionCreates).toBe(0);
    expect(record.activeTurnId).toBe(TURN_ID);
    expect(emitted[0]).toMatchObject({
      type: "session.state.changed",
      turnId: TURN_ID,
      payload: {
        state: "error",
        reason: "provider.recovering",
        detail: { message: "SSE event stream ended unexpectedly." },
      },
    });
    owner.stop();
  });

  it("cancels a retry delay without subscribing again after disposal", async () => {
    let subscriptions = 0;
    const client: { event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> } } = {
      event: { subscribe: async () => ({ stream: eofStream() }) },
    };
    const record = session(client);
    client.event.subscribe = async () => {
      subscriptions += 1;
      return { stream: eofStream() };
    };
    const owner = startEventStream(
      record,
      () => Effect.void,
      makeSyntheticEvent,
      () => Effect.void,
      ServiceMap.empty(),
      undefined,
      { retryDelays: [10_000], random: () => 0 },
    );

    await eventually(() => expect(subscriptions).toBe(1));
    owner.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(subscriptions).toBe(1);
  });

  it("fences events from an invalidated stream owner", async () => {
    let resolveEvent: ((result: IteratorResult<OpencodeEvent>) => void) | undefined;
    let handled = 0;
    const stream = {
      next: () => new Promise<IteratorResult<OpencodeEvent>>((resolve) => (resolveEvent = resolve)),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const record = session({ event: { subscribe: async () => ({ stream }) } });
    const owner = startEventStream(
      record,
      () => Effect.sync(() => void (handled += 1)),
      makeSyntheticEvent,
      () => Effect.void,
      ServiceMap.empty(),
    );

    await eventually(() => expect(resolveEvent).toBeDefined());
    owner.invalidate();
    resolveEvent?.({ value: event(), done: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handled).toBe(0);
  });

  it("emits only one recovery notification for repeated invalidation of a stream generation", async () => {
    const emitted: ProviderRuntimeEvent[] = [];
    const record = session({ event: { subscribe: async () => ({ stream: eofStream() }) } });
    const owner = startEventStream(
      record,
      () => Effect.void,
      makeSyntheticEvent,
      (events) => Effect.sync(() => void emitted.push(...events)),
      ServiceMap.empty(),
      undefined,
      { retryDelays: [10_000], random: () => 0 },
    );

    await eventually(() => expect(record.sseAbortController).not.toBeNull());
    owner.invalidate();
    owner.invalidate();
    await eventually(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]).toMatchObject({ type: "session.state.changed", turnId: TURN_ID });
    owner.stop();
  });

  it("suppresses a recovery notification when the matching turn completes during retry", async () => {
    let subscriptions = 0;
    const emitted: ProviderRuntimeEvent[] = [];
    const record = session({
      event: {
        subscribe: async () => {
          subscriptions += 1;
          return { stream: eofStream() };
        },
      },
    });
    const owner = startEventStream(
      record,
      () => Effect.void,
      makeSyntheticEvent,
      (events) => Effect.sync(() => void emitted.push(...events)),
      ServiceMap.empty(),
      async (activeSession) => {
        activeSession.activeTurnId = undefined;
      },
      { retryDelays: [0, 0, 0], random: () => 0 },
    );

    await eventually(() => expect(subscriptions).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(record.activeTurnId).toBeUndefined();
    expect(emitted).toEqual([]);
    owner.stop();
  });

  it("does not let a replaced owner reconnect or process events", async () => {
    let subscriptions = 0;
    let handled = 0;
    const client: { event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> } } = {
      event: { subscribe: async () => ({ stream: eofStream() }) },
    };
    const record = session(client);
    client.event.subscribe = async () => {
      subscriptions += 1;
      return {
        stream:
          subscriptions === 1
            ? eofStream()
            : ({
                async *[Symbol.asyncIterator]() {
                  yield event();
                },
              } as AsyncIterable<OpencodeEvent>),
      };
    };
    const first = startEventStream(
      record,
      () => Effect.sync(() => void (handled += 1)),
      makeSyntheticEvent,
      () => Effect.void,
      ServiceMap.empty(),
      undefined,
      { retryDelays: [10_000], random: () => 0 },
    );
    await eventually(() => expect(subscriptions).toBe(1));
    const second = startEventStream(
      record,
      () => Effect.sync(() => void (handled += 1)),
      makeSyntheticEvent,
      () => Effect.void,
      ServiceMap.empty(),
      undefined,
      { retryDelays: [10_000], random: () => 0 },
    );

    await eventually(() => expect(handled).toBe(1));
    expect(subscriptions).toBe(2);
    first.stop();
    second.stop();
  });
});
