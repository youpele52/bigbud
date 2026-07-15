import { ThreadId } from "@bigbud/contracts";
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { makeTurnMethods } from "./Adapter.session.turn.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-attachment-test");

it.effect("maps prompt responses into canonical OpenCode runtime events", () => {
  const emitted: Array<{ type: string; payload: unknown; itemId?: string; turnId?: string }> = [];
  let promptSent = false;

  const record = {
    client: {
      session: {
        promptAsync: async () => {
          promptSent = true;
          return {
            data: {},
            error: undefined,
          };
        },
        messages: async () => ({
          data: promptSent
            ? [
                {
                  info: {
                    id: "assistant-msg-3",
                    role: "assistant",
                    modelID: "big-pickle",
                    providerID: "opencode",
                    time: { completed: Date.now() },
                    tokens: {
                      input: 12,
                      output: 8,
                      reasoning: 0,
                      cache: { read: 5, write: 0 },
                    },
                  },
                  parts: [
                    {
                      id: "reasoning-part-1",
                      type: "reasoning",
                      text: "Thinking",
                    },
                    {
                      id: "text-part-1",
                      type: "text",
                      text: "Hello from OpenCode",
                    },
                  ],
                },
              ]
            : [],
          error: undefined,
        }),
      },
    },
    releaseServer: () => undefined,
    opencodeSessionId: "opencode-session-1",
    threadId: THREAD_ID,
    createdAt: new Date().toISOString(),
    runtimeMode: "full-access" as const,
    pendingPermissions: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    sseAbortController: null,
    cwd: "/tmp/opencode-project",
    model: "big-pickle",
    providerID: "opencode",
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    activeTurnId: undefined,
    lastUsage: undefined,
    wasRetrying: false,
    reasoningPartIds: new Set(),
  };

  const { sendTurn } = makeTurnMethods({
    provider: "opencode",
    requireSession: () => Effect.succeed(record as never),
    syntheticEventFn: (_threadId, type, payload, extra) =>
      Effect.succeed({
        type,
        payload,
        ...(extra?.itemId ? { itemId: extra.itemId } : {}),
        ...(extra?.turnId ? { turnId: extra.turnId } : {}),
      } as never),
    emitFn: (runtimeEvents) =>
      Effect.sync(() => {
        emitted.push(...(runtimeEvents as unknown as Array<(typeof emitted)[number]>));
      }),
    teardownSessionRecord: () => Effect.void,
    serverConfig: { attachmentsDir: "/tmp/unused-attachments-dir" },
  });

  return Effect.gen(function* () {
    const result = yield* sendTurn({
      threadId: THREAD_ID,
      input: "Say hello",
    });
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    expect(result.resumeCursor).toEqual({ sessionId: "opencode-session-1" });
    expect(record.activeTurnId).toBeUndefined();
    expect(record.lastUsage).toEqual({
      usedTokens: 25,
      totalProcessedTokens: 25,
      inputTokens: 12,
      lastInputTokens: 12,
      cachedInputTokens: 5,
      lastCachedInputTokens: 5,
      outputTokens: 8,
      lastOutputTokens: 8,
      lastUsedTokens: 25,
    });
    expect(emitted.map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "content.delta",
      "thread.token-usage.updated",
      "item.completed",
      "turn.completed",
      "session.state.changed",
    ]);
    expect(
      emitted.find(
        (event) =>
          event.type === "content.delta" &&
          (event.payload as { streamKind?: string }).streamKind === "reasoning_text",
      ),
    ).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "reasoning_text", delta: "Thinking" },
      itemId: "reasoning-part-1",
    });
    expect(
      emitted.find(
        (event) =>
          event.type === "content.delta" &&
          (event.payload as { streamKind?: string }).streamKind === "assistant_text",
      ),
    ).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: "Hello from OpenCode" },
      itemId: "text-part-1",
    });
    expect(emitted.find((event) => event.type === "thread.token-usage.updated")).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 25,
        },
        accounting: {
          scope: "item",
          processedTokens: 25,
          finalized: true,
        },
      },
    });
    expect(emitted.find((event) => event.type === "item.completed")).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        detail: "Hello from OpenCode",
      },
      itemId: "text-part-1",
    });
    expect(emitted.find((event) => event.type === "turn.completed")).toMatchObject({
      type: "turn.completed",
      payload: {
        state: "completed",
      },
    });
  });
});
