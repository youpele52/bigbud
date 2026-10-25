import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { makeDeterministicRandomService, makeHarness, THREAD_ID } from "./Adapter.test.helpers.ts";
import { replayClaudeMessages } from "./Adapter.stream.subagents.test.helpers.ts";

const SESSION = "sdk-session-misc";
const SENTINEL = {
  type: "system",
  subtype: "files_persisted",
  files: [],
  failed: [],
  processed_at: "2026-10-16T00:00:00.000Z",
  uuid: "00000000-0000-4000-8000-0000000000ff",
  session_id: SESSION,
} as unknown as SDKMessage;
const isSentinel = (event: ProviderRuntimeEvent) => event.type === "files.persisted";

// Shapes follow @anthropic-ai/claude-agent-sdk 0.3.301 sdk.d.ts.
const system = (subtype: string, fields: Record<string, unknown> = {}, n = 1) =>
  ({
    type: "system",
    subtype,
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    session_id: SESSION,
    ...fields,
  }) as unknown as SDKMessage;

const run = (messages: ReadonlyArray<SDKMessage>) => {
  const harness = makeHarness();
  return replayClaudeMessages(harness, [...messages, SENTINEL], isSentinel).pipe(
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
};

const warnings = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) => (event.type === "runtime.warning" ? [event.payload.message] : []));

describe("Claude SDK 0.3.301 system and misc messages", () => {
  it.effect("treats informational kinds as no-ops without an Unhandled warning", () =>
    Effect.gen(function* () {
      const events = yield* run([
        system("thinking_tokens", { tokens: 120 }, 1),
        system("informational", { content: "fyi", level: "info" }, 2),
        system("notification", { key: "k", text: "Note", priority: "low" }, 3),
        system("session_state_changed", { state: "running" }, 4),
        system("memory_recall", { memories: [] }, 5),
        system("local_command_output", { content: "done" }, 6),
        system("mirror_error", { error: "mirror failed" }, 7),
        {
          type: "prompt_suggestion",
          suggestion: "Run the tests",
          uuid: "00000000-0000-4000-8000-000000000008",
          session_id: SESSION,
        } as unknown as SDKMessage,
      ]);
      assert.deepEqual(warnings(events), []);
      assert.equal(JSON.stringify(events).includes("Run the tests"), false);
    }),
  );

  it.effect(
    "surfaces permission denials as an activity and failed plugin installs as warnings",
    () =>
      Effect.gen(function* () {
        const events = yield* run([
          system(
            "permission_denied",
            {
              tool_name: "Bash",
              tool_use_id: "toolu_denied",
              decision_reason_type: "rule",
              decision_reason: "Denied by settings rule",
              message: "Permission denied",
            },
            1,
          ),
          system("plugin_install", { status: "started" }, 2),
          system("plugin_install", { status: "failed", name: "my-market", error: "404" }, 3),
          system("plugin_install", { status: "completed" }, 4),
        ]);
        const messages = warnings(events);
        assert.equal(messages.length, 2);
        assert.match(messages[0]!, /Bash.*Denied by settings rule/);
        assert.match(messages[1]!, /my-market.*404/);
      }),
  );

  it.effect("reports worker shutdown as a state change, not session death", () =>
    Effect.gen(function* () {
      const events = yield* run([system("worker_shutting_down", { reason: "host_exit" })]);
      const state = events.find(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.reason?.startsWith("worker_shutting_down"),
      );
      assert.equal(
        state?.type === "session.state.changed" && state.payload.reason,
        "worker_shutting_down:host_exit",
      );
      assert.equal(
        events.some((event) => event.type === "session.exited"),
        false,
      );
      assert.deepEqual(warnings(events), []);
    }),
  );
});

describe("Claude commands_changed", () => {
  it.effect("reports changed commands as configuration, not a warning", () =>
    Effect.gen(function* () {
      const events = yield* run([
        system("commands_changed", {
          commands: [
            { name: "review", description: "Review code", argumentHint: "" },
            { name: "deploy", description: "Deploy", argumentHint: "<env>" },
          ],
        }),
      ]);
      const configured = events.find(
        (event) => event.type === "session.configured" && event.payload.config.commandsChanged,
      );
      assert.deepEqual(configured?.type === "session.configured" && configured.payload.config, {
        commandsChanged: true,
        commandCount: 2,
      });
      assert.deepEqual(warnings(events), []);
    }),
  );
});

describe("Claude conversation_reset", () => {
  it.effect("drops the resume anchor and emits a reset thread state", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(isSentinel),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
      harness.query.emit({
        type: "assistant",
        uuid: "11111111-1111-4111-8111-111111111111",
        session_id: SESSION,
        parent_tool_use_id: null,
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "hi" }],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } as unknown as SDKMessage);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      const before = (yield* adapter.listSessions())[0]?.resumeCursor as Record<string, unknown>;
      assert.equal(before.resumeSessionAt, "11111111-1111-4111-8111-111111111111");
      harness.query.emit({
        type: "conversation_reset",
        new_conversation_id: "22222222-2222-4222-8222-222222222222",
        trigger: "clear",
        uuid: "33333333-3333-4333-8333-333333333333",
        session_id: SESSION,
      } as unknown as SDKMessage);
      harness.query.emit(SENTINEL);
      const events = Array.from(yield* Fiber.join(fiber));
      const reset = events.find(
        (event) => event.type === "thread.state.changed" && event.payload.state === "reset",
      );
      assert.deepEqual(reset?.type === "thread.state.changed" && reset.payload.detail, {
        trigger: "clear",
        newConversationId: "22222222-2222-4222-8222-222222222222",
      });
      const after = (yield* adapter.listSessions())[0]?.resumeCursor as Record<string, unknown>;
      assert.equal(after.resumeSessionAt, undefined);
      assert.equal(after.resume, SESSION);
      assert.deepEqual(warnings(events), []);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
