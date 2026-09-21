import { EventId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Queue } from "effect";

import type { OpencodeServerHandle } from "../../Services/Opencode/ServerManager.ts";
import { makeSessionMethods } from "./Adapter.session.ts";
import { makeMockOpencodeClient } from "./Adapter.session.test.helpers.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-session-test");
const CREATED_AT = "2026-05-14T00:00:00.000Z";

describe("Opencode session orchestration MCP", () => {
  it.effect("restricts each OpenCode session to its own orchestration tool IDs", () =>
    Effect.gen(function* () {
      const sessions = new Map();
      const handle: OpencodeServerHandle = {
        client: makeMockOpencodeClient(),
        url: "http://127.0.0.1:4101",
        release() {},
        invalidate() {},
      };

      const methods = makeSessionMethods({
        provider: "opencode",
        sessions,
        runtimeEventQueue: yield* Queue.unbounded<ProviderRuntimeEvent>(),
        serverManager: {
          acquire: async () => handle,
        },
        serverSettings: {
          getSettings: Effect.succeed({
            providers: {
              opencode: {
                binaryPath: "opencode",
              },
            },
          } as never),
        },
        serverConfig: {
          attachmentsDir: "/tmp/attachments",
          stateDir: "/tmp/bigbud-state",
          port: 3773,
          host: "127.0.0.1",
        },
        nextEventId: Effect.succeed(EventId.makeUnsafe("evt-next")),
        makeEventStamp: () =>
          Effect.succeed({
            eventId: EventId.makeUnsafe("evt-tools"),
            createdAt: CREATED_AT,
          }),
        nativeEventLogger: undefined,
        services: yield* Effect.services<never>(),
      });

      yield* methods.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        runtimeMode: "approval-required",
      });

      expect(sessions.get(THREAD_ID)?.allowedTools).toEqual({
        bash: true,
        read: true,
        "bigbud_orchestration_thread-opencode-session-test_rename_thread": true,
        "bigbud_orchestration_thread-opencode-session-test_archive_thread": true,
        "bigbud_orchestration_other-thread_rename_thread": false,
      });
    }),
  );

  it.effect("disconnects the thread-scoped orchestration MCP bridge when stopping a session", () =>
    Effect.gen(function* () {
      const mcpDisconnectCalls: Array<Record<string, unknown>> = [];
      const handle: OpencodeServerHandle = {
        client: makeMockOpencodeClient({
          onMcpDisconnect: (mcpInput) => {
            mcpDisconnectCalls.push(mcpInput);
          },
        }),
        url: "http://127.0.0.1:4102",
        release() {},
        invalidate() {},
      };

      const methods = makeSessionMethods({
        provider: "opencode",
        sessions: new Map(),
        runtimeEventQueue: yield* Queue.unbounded<ProviderRuntimeEvent>(),
        serverManager: {
          acquire: async () => handle,
        },
        serverSettings: {
          getSettings: Effect.succeed({
            providers: {
              opencode: {
                binaryPath: "opencode",
              },
            },
          } as never),
        },
        serverConfig: {
          attachmentsDir: "/tmp/attachments",
          stateDir: "/tmp/bigbud-state",
          port: 3773,
          host: "127.0.0.1",
        },
        nextEventId: Effect.succeed(EventId.makeUnsafe("evt-next")),
        makeEventStamp: () =>
          Effect.succeed({
            eventId: EventId.makeUnsafe("evt-disconnect"),
            createdAt: CREATED_AT,
          }),
        nativeEventLogger: undefined,
        services: yield* Effect.services<never>(),
      });

      yield* methods.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        runtimeMode: "approval-required",
      });
      yield* methods.stopSession(THREAD_ID);

      expect(mcpDisconnectCalls).toEqual([
        { name: "bigbud_orchestration_thread-opencode-session-test" },
      ]);
    }),
  );

  it.effect("continues starting the session when orchestration MCP registration fails", () =>
    Effect.gen(function* () {
      const sessions = new Map();
      const handle: OpencodeServerHandle = {
        client: makeMockOpencodeClient({
          onMcpAdd: () => {
            throw new Error("MCP handshake timed out.");
          },
        }),
        url: "http://127.0.0.1:4103",
        release() {},
        invalidate() {},
      };

      const methods = makeSessionMethods({
        provider: "opencode",
        sessions,
        runtimeEventQueue: yield* Queue.unbounded<ProviderRuntimeEvent>(),
        serverManager: {
          acquire: async () => handle,
        },
        serverSettings: {
          getSettings: Effect.succeed({
            providers: {
              opencode: {
                binaryPath: "opencode",
              },
            },
          } as never),
        },
        serverConfig: {
          attachmentsDir: "/tmp/attachments",
          stateDir: "/tmp/bigbud-state",
          port: 3773,
          host: "127.0.0.1",
        },
        nextEventId: Effect.succeed(EventId.makeUnsafe("evt-mcp-failure")),
        makeEventStamp: () =>
          Effect.succeed({
            eventId: EventId.makeUnsafe("evt-mcp-failure"),
            createdAt: CREATED_AT,
          }),
        nativeEventLogger: undefined,
        services: yield* Effect.services<never>(),
      });

      const session = yield* methods.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        runtimeMode: "approval-required",
      });

      expect(session.threadId).toBe(THREAD_ID);
      expect(sessions.has(THREAD_ID)).toBe(true);
    }),
  );
});
