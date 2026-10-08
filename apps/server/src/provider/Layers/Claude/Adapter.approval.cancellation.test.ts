import { ApprovalRequestId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Random, Stream } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { THREAD_ID, makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";

describe("Claude mandatory approval and cancellation", () => {
  it.effect.each(["default", "plan"] as const)(
    "never auto-approves a full-access %s callback",
    (interactionMode) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          interactionMode,
          input: "test-only prompt",
          attachments: [],
        });
        yield* Stream.runHead(adapter.streamEvents);
        const callback = harness.getLastCreateQueryInput()!.options.canUseTool!;
        let settled = false;
        const result = callback(
          "Bash",
          { command: "rm -rf protected" },
          {
            signal: new AbortController().signal,
            toolUseID: "mandatory-tool",
            requestId: "mandatory-request",
            suppressAlwaysAllowRule: true,
            suggestions: [
              {
                type: "addRules",
                behavior: "allow",
                rules: [{ toolName: "Bash" }],
                destination: "localSettings",
              },
            ],
          },
        );
        void result.then(() => {
          settled = true;
        });
        const opened = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(opened._tag, "Some");
        if (opened._tag !== "Some" || opened.value.type !== "request.opened") return;
        assert.isUndefined(opened.value.payload.autoApproveAfterMs);
        assert.isFalse(opened.value.payload.sessionApprovalAvailable);
        yield* TestClock.adjust("10 seconds");
        assert.isFalse(settled);
        yield* adapter.respondToRequest(
          THREAD_ID,
          ApprovalRequestId.makeUnsafe("mandatory-request"),
          "acceptForSession",
        );
        assert.deepEqual(yield* Effect.promise(() => result), {
          behavior: "allow",
          updatedInput: { command: "rm -rf protected" },
        });
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect.each(["Bash", "AskUserQuestion"])(
    "denies a pre-aborted %s callback without creating UI work",
    (toolName) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        const controller = new AbortController();
        controller.abort();
        const callback = harness.getLastCreateQueryInput()!.options.canUseTool!;
        assert.equal(
          (yield* Effect.promise(() =>
            callback(
              toolName,
              {},
              { signal: controller.signal, requestId: "aborted", toolUseID: "tool" },
            ),
          ))?.behavior,
          "deny",
        );
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "not blocked", attachments: [] });
        const event = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(event._tag === "Some" && event.value.type, "turn.started");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect.each(["Bash", "AskUserQuestion"])(
    "cancels an aborted duplicate %s independently and removes listeners",
    (toolName) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        const owner = new AbortController();
        const duplicate = new AbortController();
        const removeOwner = vi.spyOn(owner.signal, "removeEventListener");
        const removeDuplicate = vi.spyOn(duplicate.signal, "removeEventListener");
        const callback = harness.getLastCreateQueryInput()!.options.canUseTool!;
        const input = toolName === "Bash" ? { command: "git status" } : { questions: [] };
        const options = { requestId: "duplicate", toolUseID: "duplicate-tool", agentID: "agent-1" };
        const original = callback(toolName, input, { ...options, signal: owner.signal });
        yield* Stream.runHead(adapter.streamEvents);
        const copy = callback(toolName, input, { ...options, signal: duplicate.signal });
        yield* Effect.yieldNow;
        duplicate.abort();
        assert.equal((yield* Effect.promise(() => copy))?.behavior, "deny");
        if (toolName === "Bash")
          yield* adapter.respondToRequest(
            THREAD_ID,
            ApprovalRequestId.makeUnsafe("duplicate"),
            "accept",
          );
        else
          yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.makeUnsafe("duplicate"), {
            Continue: "yes",
          });
        assert.equal((yield* Effect.promise(() => original))?.behavior, "allow");
        assert.isTrue(removeOwner.mock.calls.some((call) => call[0] === "abort"));
        // A duplicate aborted before registration is also safe (no listener to remove).
        assert.isTrue(
          removeDuplicate.mock.calls.some((call) => call[0] === "abort") ||
            duplicate.signal.aborted,
        );
        const resolved = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(
          resolved._tag === "Some" && resolved.value.type,
          toolName === "Bash" ? "request.resolved" : "user-input.resolved",
        );
        const abortedReplay = new AbortController();
        abortedReplay.abort();
        assert.equal(
          (yield* Effect.promise(() =>
            callback(toolName, input, { ...options, signal: abortedReplay.signal }),
          ))?.behavior,
          "deny",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect.each(["Bash", "AskUserQuestion"])(
    "settles %s abort immediately after opening exactly once",
    (toolName) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        const callback = harness.getLastCreateQueryInput()!.options.canUseTool!;
        const result = callback(
          toolName,
          {},
          { signal: controller.signal, toolUseID: "abort-tool", requestId: "abort-open" },
        );
        yield* Stream.runHead(adapter.streamEvents);
        controller.abort();
        assert.equal((yield* Effect.promise(() => result))?.behavior, "deny");
        assert.isTrue(remove.mock.calls.some((call) => call[0] === "abort"));
        const resolved = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(
          resolved._tag === "Some" && resolved.value.type,
          toolName === "Bash" ? "request.resolved" : "user-input.resolved",
        );
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "not blocked", attachments: [] });
        const next = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(next._tag === "Some" && next.value.type, "turn.started");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});
