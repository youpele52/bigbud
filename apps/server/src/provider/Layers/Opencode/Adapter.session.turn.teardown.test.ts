import { ThreadId } from "@bigbud/contracts";
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { makeTurnMethods } from "./Adapter.session.turn.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-attachment-test");

it.effect("tears down broken OpenCode sessions when prompt transport fails", () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  let tornDown = false;

  const record = {
    client: {
      session: {
        messages: async () => ({
          data: [],
          error: undefined,
        }),
        promptAsync: async () => ({
          data: undefined,
          error: new TypeError("fetch failed"),
        }),
      },
    },
    releaseServer: () => undefined,
    opencodeSessionId: "opencode-session-transport-failure",
    threadId: THREAD_ID,
    createdAt: new Date().toISOString(),
    runtimeMode: "full-access" as const,
    pendingPermissions: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    sseAbortController: null,
    cwd: "/tmp/opencode-project",
    model: undefined,
    providerID: undefined,
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
    syntheticEventFn: (_threadId, type, payload) =>
      Effect.succeed({
        type,
        payload,
      } as never),
    emitFn: (runtimeEvents) =>
      Effect.sync(() => {
        emitted.push(...(runtimeEvents as unknown as Array<(typeof emitted)[number]>));
      }),
    teardownSessionRecord: () =>
      Effect.sync(() => {
        tornDown = true;
      }),
    serverConfig: { attachmentsDir: "/tmp/unused-attachments-dir" },
  });

  return Effect.gen(function* () {
    yield* sendTurn({
      threadId: THREAD_ID,
      input: "Say hello",
    });
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    expect(tornDown).toBe(true);
    expect(emitted.map((event) => event.type)).toEqual([
      "turn.started",
      "runtime.error",
      "turn.completed",
      "session.state.changed",
    ]);
  });
});
