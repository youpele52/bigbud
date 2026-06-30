import fs from "node:fs/promises";

import {
  EventId,
  LOCAL_EXECUTION_TARGET_ID,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { describe, expect, it } from "@effect/vitest";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import { Effect, Queue } from "effect";

import type { OpencodeServerHandle } from "../../Services/Opencode/ServerManager.ts";
import { makeSessionMethods } from "./Adapter.session.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-session-test");
const CREATED_AT = "2026-05-14T00:00:00.000Z";
const APPROVAL_REQUIRED_RULES: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "ask" },
  { permission: "bash", pattern: "*", action: "ask" },
  { permission: "edit", pattern: "*", action: "ask" },
  { permission: "webfetch", pattern: "*", action: "ask" },
  { permission: "websearch", pattern: "*", action: "ask" },
  { permission: "codesearch", pattern: "*", action: "ask" },
  { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "doom_loop", pattern: "*", action: "ask" },
  { permission: "question", pattern: "*", action: "allow" },
];
const AUTO_ACCEPT_EDITS_RULES: PermissionRuleset = [
  ...APPROVAL_REQUIRED_RULES,
  { permission: "edit", pattern: "*", action: "allow" },
];
const FULL_ACCESS_RULES: PermissionRuleset = [{ permission: "*", pattern: "*", action: "allow" }];

function makeEmptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true, value: undefined as T };
        },
      };
    },
  };
}

function makeMockOpencodeClient(input?: {
  readonly onSessionCreate?: (sessionInput: Record<string, unknown>) => void;
  readonly onMcpAdd?: (mcpInput: Record<string, unknown>) => void;
  readonly onMcpConnect?: (mcpInput: Record<string, unknown>) => void;
}) {
  return {
    session: {
      create: async (sessionInput: Record<string, unknown>) => {
        input?.onSessionCreate?.(sessionInput);
        return {
          data: {
            id: "opencode-session-1",
          },
          error: undefined,
        };
      },
    },
    event: {
      subscribe: async () => ({
        stream: makeEmptyAsyncIterable<unknown>(),
      }),
    },
    mcp: {
      add: async (mcpInput: Record<string, unknown>) => {
        input?.onMcpAdd?.(mcpInput);
        return { data: {}, error: undefined };
      },
      connect: async (mcpInput: Record<string, unknown>) => {
        input?.onMcpConnect?.(mcpInput);
        return { data: {}, error: undefined };
      },
    },
  } as never;
}

describe("Opencode session lifecycle", () => {
  for (const [runtimeMode, expectedRules] of [
    ["approval-required", APPROVAL_REQUIRED_RULES],
    ["auto-accept-edits", AUTO_ACCEPT_EDITS_RULES],
    ["full-access", FULL_ACCESS_RULES],
  ] as const) {
    it.effect(`passes explicit ${runtimeMode} permission rules into OpenCode session.create`, () =>
      Effect.gen(function* () {
        const createInputs: Array<Record<string, unknown>> = [];
        const handle: OpencodeServerHandle = {
          client: makeMockOpencodeClient({
            onSessionCreate: (sessionInput) => {
              createInputs.push(sessionInput);
            },
          }),
          url: "http://127.0.0.1:4096",
          release() {},
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
              eventId: EventId.makeUnsafe("evt-1"),
              createdAt: CREATED_AT,
            }),
          nativeEventLogger: undefined,
          services: yield* Effect.services<never>(),
        });

        const session = yield* methods.startSession({
          threadId: THREAD_ID,
          provider: "opencode",
          runtimeMode,
          cwd: "/tmp/bigbud-project",
        });

        expect(session.runtimeMode).toBe(runtimeMode);
        expect(createInputs).toHaveLength(1);
        expect(createInputs[0]).toEqual({
          title: "bigbud session in /tmp/bigbud-project",
          permission: expectedRules,
        });
      }),
    );
  }

  it.effect("runs OpenCode locally against a synthetic workspace for remote projects", () =>
    Effect.gen(function* () {
      const acquireCalls: Array<unknown> = [];
      const handle: OpencodeServerHandle = {
        client: makeMockOpencodeClient(),
        url: "http://127.0.0.1:4097",
        release() {},
      };

      const methods = makeSessionMethods({
        provider: "opencode",
        sessions: new Map(),
        runtimeEventQueue: yield* Queue.unbounded<ProviderRuntimeEvent>(),
        serverManager: {
          acquire: async (input) => {
            acquireCalls.push(input);
            return handle;
          },
        },
        serverSettings: {
          getSettings: Effect.succeed({
            providers: {
              opencode: {
                binaryPath: "/opt/opencode/bin/opencode",
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
            eventId: EventId.makeUnsafe("evt-remote"),
            createdAt: CREATED_AT,
          }),
        nativeEventLogger: undefined,
        services: yield* Effect.services<never>(),
      });

      const session = yield* methods.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        runtimeMode: "full-access",
        cwd: "/root/project",
      });

      expect(acquireCalls).toHaveLength(1);
      const acquireInput = acquireCalls[0] as {
        readonly binaryPath: string;
        readonly directory: string;
        readonly executionTargetId: string;
      };
      expect(acquireInput.binaryPath).toBe("/opt/opencode/bin/opencode");
      expect(acquireInput.executionTargetId).toBe(LOCAL_EXECUTION_TARGET_ID);
      expect(acquireInput.directory).not.toBe("/root/project");
      expect(acquireInput.directory).toContain("bigbud-opencode-remote-workspace-");
      yield* Effect.promise(() =>
        expect(
          fs.access(`${acquireInput.directory}/.opencode/tools/read.ts`),
        ).resolves.toBeUndefined(),
      );

      expect(session.providerRuntimeExecutionTargetId).toBe(LOCAL_EXECUTION_TARGET_ID);
      expect(session.workspaceExecutionTargetId).toBe(
        "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      );
      expect(session.executionTargetId).toBe("ssh:host=devbox&user=root&port=22&auth=ssh-key");

      yield* methods.stopSession(THREAD_ID);
      yield* Effect.promise(() => expect(fs.access(acquireInput.directory)).rejects.toThrow());
    }),
  );

  it.effect("registers orchestration MCP for OpenCode sessions without a cwd", () =>
    Effect.gen(function* () {
      const acquireCalls: Array<unknown> = [];
      const mcpAddCalls: Array<Record<string, unknown>> = [];
      const mcpConnectCalls: Array<Record<string, unknown>> = [];
      const handle: OpencodeServerHandle = {
        client: makeMockOpencodeClient({
          onMcpAdd: (mcpInput) => {
            mcpAddCalls.push(mcpInput);
          },
          onMcpConnect: (mcpInput) => {
            mcpConnectCalls.push(mcpInput);
          },
        }),
        url: "http://127.0.0.1:4098",
        release() {},
      };

      const methods = makeSessionMethods({
        provider: "opencode",
        sessions: new Map(),
        runtimeEventQueue: yield* Queue.unbounded<ProviderRuntimeEvent>(),
        serverManager: {
          acquire: async (input) => {
            acquireCalls.push(input);
            return handle;
          },
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
            eventId: EventId.makeUnsafe("evt-global"),
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

      expect(acquireCalls).toHaveLength(1);
      expect(acquireCalls[0]).not.toHaveProperty("directory");
      expect(mcpAddCalls).toEqual([
        {
          name: "bigbud_orchestration",
          config: {
            type: "local",
            command: expect.arrayContaining([expect.any(String)]),
          },
        },
      ]);
      expect(mcpConnectCalls).toEqual([{ name: "bigbud_orchestration" }]);
    }),
  );

  it.effect("registers orchestration MCP for KiloCode sessions", () =>
    Effect.gen(function* () {
      const mcpAddCalls: Array<Record<string, unknown>> = [];
      const handle: OpencodeServerHandle = {
        client: makeMockOpencodeClient({
          onMcpAdd: (mcpInput) => {
            mcpAddCalls.push(mcpInput);
          },
        }),
        url: "http://127.0.0.1:4100",
        release() {},
      };

      const methods = makeSessionMethods({
        provider: "kilocode",
        sessions: new Map(),
        runtimeEventQueue: yield* Queue.unbounded<ProviderRuntimeEvent>(),
        serverManager: {
          acquire: async () => handle,
        },
        serverSettings: {
          getSettings: Effect.succeed({
            providers: {
              kilocode: {
                binaryPath: "kilo",
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
        nextEventId: Effect.succeed(EventId.makeUnsafe("evt-kilo-next")),
        makeEventStamp: () =>
          Effect.succeed({
            eventId: EventId.makeUnsafe("evt-kilo"),
            createdAt: CREATED_AT,
          }),
        nativeEventLogger: undefined,
        services: yield* Effect.services<never>(),
      });

      yield* methods.startSession({
        threadId: THREAD_ID,
        provider: "kilocode",
        runtimeMode: "approval-required",
      });

      expect(mcpAddCalls).toEqual([
        {
          name: "bigbud_orchestration",
          config: {
            type: "local",
            command: expect.arrayContaining([expect.any(String)]),
          },
        },
      ]);

      const command = (mcpAddCalls[0]?.config as { command?: ReadonlyArray<string> } | undefined)
        ?.command;
      const serverPath = command?.[1];
      expect(typeof serverPath).toBe("string");
      if (typeof serverPath === "string") {
        const source = yield* Effect.promise(() => fs.readFile(serverPath, "utf8"));
        expect(source).toContain("computer_use");
      }
    }),
  );

  it.effect("does not write orchestration tool files into the project cwd", () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => fs.mkdtemp("/tmp/bigbud-opencode-project-"));
      const mcpAddCalls: Array<Record<string, unknown>> = [];
      const handle: OpencodeServerHandle = {
        client: makeMockOpencodeClient({
          onMcpAdd: (mcpInput) => {
            mcpAddCalls.push(mcpInput);
          },
        }),
        url: "http://127.0.0.1:4099",
        release() {},
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
            eventId: EventId.makeUnsafe("evt-project"),
            createdAt: CREATED_AT,
          }),
        nativeEventLogger: undefined,
        services: yield* Effect.services<never>(),
      });

      try {
        yield* methods.startSession({
          threadId: THREAD_ID,
          provider: "opencode",
          runtimeMode: "approval-required",
          cwd: projectDir,
        });

        expect(mcpAddCalls).toEqual([
          {
            directory: projectDir,
            name: "bigbud_orchestration",
            config: {
              type: "local",
              command: expect.arrayContaining([expect.any(String)]),
            },
          },
        ]);
        yield* Effect.promise(() =>
          expect(fs.access(`${projectDir}/.opencode/tools/rename_thread.ts`)).rejects.toThrow(),
        );
        yield* Effect.promise(() =>
          expect(
            fs.access(`${projectDir}/.bigbud/opencode-orchestration-runtime.ts`),
          ).rejects.toThrow(),
        );
      } finally {
        yield* Effect.promise(() => fs.rm(projectDir, { recursive: true, force: true }));
      }
    }),
  );
});
