import fs from "node:fs/promises";

import {
  EventId,
  LOCAL_EXECUTION_TARGET_ID,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Queue } from "effect";

import type { OpencodeServerHandle } from "../../Services/Opencode/ServerManager.ts";
import { makeSessionMethods } from "./Adapter.session.ts";
import {
  APPROVAL_REQUIRED_RULES,
  AUTO_ACCEPT_EDITS_RULES,
  FULL_ACCESS_RULES,
  makeMockOpencodeClient,
} from "./Adapter.session.test.helpers.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-session-test");
const CREATED_AT = "2026-05-14T00:00:00.000Z";

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
});
