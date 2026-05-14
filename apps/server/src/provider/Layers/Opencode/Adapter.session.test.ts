import { EventId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
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

describe("Opencode session lifecycle", () => {
  for (const [runtimeMode, expectedRules] of [
    ["approval-required", APPROVAL_REQUIRED_RULES],
    ["auto-accept-edits", AUTO_ACCEPT_EDITS_RULES],
    ["full-access", FULL_ACCESS_RULES],
  ] as const) {
    it.effect(`passes explicit ${runtimeMode} permission rules into OpenCode session.create`, () =>
      Effect.gen(function* () {
        const createInputs: Array<Record<string, unknown>> = [];
        const subscribe = async () => ({
          stream: makeEmptyAsyncIterable<unknown>(),
        });
        const handle: OpencodeServerHandle = {
          client: {
            session: {
              create: async (input: Record<string, unknown>) => {
                createInputs.push(input);
                return {
                  data: {
                    id: "opencode-session-1",
                  },
                  error: undefined,
                };
              },
            },
            event: {
              subscribe,
            },
          } as never,
          url: "http://127.0.0.1:4096",
          release() {},
        };

        const methods = makeSessionMethods({
          sessions: new Map(),
          runtimeEventQueue: yield* Queue.unbounded<ProviderRuntimeEvent>(),
          serverManager: {
            acquire: async () => handle,
          },
          serverConfig: { attachmentsDir: "/tmp/attachments" },
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
});
