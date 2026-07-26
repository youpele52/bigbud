import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { ApprovalRequestId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { THREAD_ID, makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";

describe("Claude approval request lifecycle", () => {
  it.effect("cancels pending user input once when a session stops", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) return;

      const permission = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-stop-input",
          requestId: "sdk-request-stop-input",
        },
      );
      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") return;
      assert.equal(requested.value.type, "user-input.requested");

      yield* adapter.stopSession(THREAD_ID);
      const afterStop = yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);
      const resolved = afterStop.filter((event) => event.type === "user-input.resolved");
      assert.equal(resolved.length, 1);

      const result = yield* Effect.promise(() => permission);
      assert.deepEqual(result, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("replays the stored user-input SDK result", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) return;
      const options = {
        signal: new AbortController().signal,
        toolUseID: "tool-replay-input",
        requestId: "sdk-request-replay-input",
      };
      const input = {
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [{ label: "Yes", description: "Proceed" }],
            multiSelect: false,
          },
        ],
      };
      const first = canUseTool("AskUserQuestion", input, options);
      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") return;
      if (requested.value.requestId === undefined) return;
      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(String(requested.value.requestId)),
        {
          Continue: "Yes",
        },
      );
      yield* Stream.runHead(adapter.streamEvents);
      const firstResult = yield* Effect.promise(() => first);

      const replay = yield* Effect.promise(() => canUseTool("AskUserQuestion", input, options));
      assert.deepEqual(replay, firstResult);
      yield* adapter.stopSession(session.threadId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
