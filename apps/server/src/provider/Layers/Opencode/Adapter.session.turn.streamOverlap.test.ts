import { EventId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeTurnMethods } from "./Adapter.session.turn.ts";
import { makeMapEvent } from "./Adapter.stream.mapEvent.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { makeBackgroundReviewResponse } from "../ProviderService.backgroundReview.response.ts";

const THREAD_ID = ThreadId.makeUnsafe("memory-review-overlap");
const MEMORY_JSON =
  '{"userMemory":"Prefers concise answers","globalMemory":null,"projectMemory":null,"skillPatch":null}';

function reply(text: string, completed = true, id = "assistant-1") {
  return [
    {
      info: {
        id,
        role: "assistant",
        time: completed ? { completed: 100 } : { created: 50 },
      },
      parts: [{ id: `${id}-text`, type: "text", text }],
    },
  ];
}

type Messages = ReturnType<typeof reply>;

function deferredMessages() {
  let resolve!: (messages: Messages) => void;
  const promise = new Promise<Messages>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function harness(provider: "opencode" | "kilocode") {
  const emitted: ProviderRuntimeEvent[] = [];
  const responses: Array<Promise<Messages> | Messages> = [[]];
  let calls = 0;
  let syntheticId = 0;
  const record = {
    client: {
      session: {
        promptAsync: async () => ({ data: {}, error: undefined }),
        messages: async () => {
          calls += 1;
          const next = responses.shift();
          if (!next) throw new Error("Unexpected messages request");
          return { data: await next, error: undefined };
        },
      },
    },
    releaseServer: () => undefined,
    opencodeSessionId: "session-memory",
    threadId: THREAD_ID,
    sessionEpoch: 0,
    createdAt: new Date().toISOString(),
    runtimeMode: "full-access",
    pendingPermissions: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    sseAbortController: null,
    cwd: "/tmp/memory-review",
    model: "test-model",
    providerID: "test-provider",
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    activeTurnId: undefined,
    lastUsage: undefined,
    wasRetrying: false,
    reasoningPartIds: new Set(),
    allowedTools: {},
  } as unknown as ActiveOpencodeSession;
  const { sendTurn } = makeTurnMethods({
    provider,
    requireSession: () => Effect.succeed(record),
    syntheticEventFn: (_threadId, _epoch, type, payload, extra) =>
      Effect.succeed({
        type,
        payload,
        provider,
        eventId: EventId.makeUnsafe(`synthetic-${++syntheticId}`),
        ...extra,
      } as never),
    emitFn: (events) => Effect.sync(() => void emitted.push(...events)),
    teardownSessionRecord: () => Effect.void,
    serverConfig: { attachmentsDir: "/tmp/unused-attachments-dir" },
  });
  const eventId = Effect.sync(() => EventId.makeUnsafe(`event-${emitted.length}`));
  const mapEvent = makeMapEvent(
    eventId,
    () => Effect.map(eventId, (id) => ({ eventId: id, createdAt: new Date().toISOString() })),
    provider,
  );
  const sse = async (type: string, properties: object) => {
    emitted.push(
      ...(await Effect.runPromise(mapEvent(record, { type, properties } as OpencodeEvent))),
    );
  };
  return {
    record,
    emitted,
    responses,
    start: () => Effect.runPromise(sendTurn({ threadId: THREAD_ID, input: "Review memory" })),
    waitCalls: (count: number) => vi.waitFor(() => expect(calls).toBe(count), { timeout: 3_000 }),
    waitCompleted: () => vi.waitFor(() => expect(record.activeTurnId).toBeUndefined()),
    sse,
    delta: (delta: string) =>
      sse("message.part.delta", {
        sessionID: record.opencodeSessionId,
        messageID: "assistant-1",
        partID: "assistant-1-text",
        field: "text",
        delta,
      }),
    text: () =>
      emitted
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta)
        .join(""),
    completions: () => emitted.filter((event) => event.type === "turn.completed"),
  };
}

describe.each(["opencode", "kilocode"] as const)("%s memory review stream overlap", (provider) => {
  it("maps multiple text parts into snapshots that the shared collector reconciles by item ID", async () => {
    const h = harness(provider);
    const first = MEMORY_JSON.slice(0, 20);
    const second = MEMORY_JSON.slice(20);
    const message = reply(MEMORY_JSON)[0]!;
    h.responses.push([
      {
        ...message,
        parts: [
          { id: "assistant-1-text", type: "text", text: first },
          { id: "assistant-1-tail", type: "text", text: second },
        ],
      },
    ]);
    await h.start();
    await h.waitCompleted();

    const response = makeBackgroundReviewResponse(24_000);
    for (const event of h.emitted) expect(response.append(event)).toBe(true);
    expect(response.text()).toBe(MEMORY_JSON);
    const completed = h.emitted.filter((event) => event.type === "item.completed");
    expect(completed.map((event) => [event.itemId, event.payload.detail])).toEqual([
      ["assistant-1-text", first],
      ["assistant-1-tail", second],
    ]);
  });

  it("emits valid memory JSON once when SSE arrives before the polling snapshot", async () => {
    const h = harness(provider);
    const final = deferredMessages();
    h.responses.push(final.promise);
    await h.start();
    await h.waitCalls(2);
    await h.delta(MEMORY_JSON.slice(0, 20));
    h.record.wasRetrying = true;
    await h.delta(MEMORY_JSON.slice(20));
    final.resolve(reply(MEMORY_JSON));
    await h.waitCompleted();

    expect(h.text()).toBe(MEMORY_JSON);
    expect(JSON.parse(h.text())).toEqual(JSON.parse(MEMORY_JSON));
    expect(h.completions()).toHaveLength(1);
    expect(h.record.wasRetrying).toBe(false);
    expect(h.emitted.every((event) => event.provider === provider)).toBe(true);
  });

  it("suppresses queued SSE text already delivered by a polling snapshot", async () => {
    const h = harness(provider);
    const final = deferredMessages();
    h.responses.push(reply(MEMORY_JSON, false), final.promise);
    await h.start();
    await vi.waitFor(() => expect(h.text()).toBe(MEMORY_JSON));
    await h.delta(MEMORY_JSON.slice(0, 20));
    await h.delta(MEMORY_JSON.slice(20));
    await h.waitCalls(3);
    final.resolve(reply(MEMORY_JSON));
    await h.waitCompleted();

    expect(h.text()).toBe(MEMORY_JSON);
    expect(h.completions()).toHaveLength(1);
  });

  it("flushes final JSON before completing once despite early and late SSE idle", async () => {
    const h = harness(provider);
    const final = deferredMessages();
    h.responses.push(final.promise);
    const turn = await h.start();
    await h.waitCalls(2);
    await h.delta(MEMORY_JSON.slice(0, 20));
    await h.sse("session.idle", { sessionID: "session-memory" });
    await h.sse("session.status", { sessionID: "session-memory", status: { type: "idle" } });
    expect(h.record.activeTurnId).toBe(turn.turnId);
    expect(h.completions()).toHaveLength(0);
    final.resolve(reply(MEMORY_JSON));
    await h.waitCompleted();
    await h.sse("session.idle", { sessionID: "session-memory" });

    expect(h.text()).toBe(MEMORY_JSON);
    expect(h.completions()).toHaveLength(1);
    const completionIndex = h.emitted.findIndex((event) => event.type === "turn.completed");
    expect(
      h.emitted.slice(completionIndex + 1).some((event) => event.type === "content.delta"),
    ).toBe(false);
    expect(h.completions()[0]?.turnId).toBe(turn.turnId);
  });

  it("ignores a previous turn's delayed polling result after a new turn starts", async () => {
    const h = harness(provider);
    const oldFinal = deferredMessages();
    const newFinal = deferredMessages();
    h.responses.push(oldFinal.promise);
    const oldTurn = await h.start();
    await h.waitCalls(2);
    h.responses.push([], newFinal.promise);
    const newTurn = await h.start();
    await h.waitCalls(4);
    oldFinal.resolve(reply("stale memory", true, "old-assistant"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.record.activeTurnId).toBe(newTurn.turnId);
    expect(h.text()).toBe("");
    expect(h.completions()).toHaveLength(0);
    newFinal.resolve(reply(MEMORY_JSON, true, "new-assistant"));
    await h.waitCompleted();
    expect(h.text()).toBe(MEMORY_JSON);
    expect(h.completions()).toHaveLength(1);
    expect(h.completions()[0]?.turnId).toBe(newTurn.turnId);
    expect(
      h.emitted.filter((event) => event.turnId === oldTurn.turnId).map((event) => event.type),
    ).toEqual(["turn.started"]);
  });
});
