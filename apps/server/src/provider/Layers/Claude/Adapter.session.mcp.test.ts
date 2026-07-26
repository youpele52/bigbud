import { assert, describe, it } from "@effect/vitest";
import { ApprovalRequestId } from "@bigbud/contracts";
import { Effect, Random, Stream } from "effect";
import { TestClock } from "effect/testing";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { makeDeterministicRandomService, makeHarness, THREAD_ID } from "./Adapter.test.helpers.ts";

const ELICITATION_REQUEST = {
  serverName: "docs",
  message: "Sign in",
  mode: "form" as const,
  elicitationId: "elicitation-1",
  requestedSchema: {
    type: "object" as const,
    properties: { token: { type: "string" } },
  },
};

describe("ClaudeAdapter MCP lifecycle", () => {
  it.effect("resolves duplicate elicitation callbacks once without exposing answers", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const onElicitation = harness.getLastCreateQueryInput()?.options.onElicitation;
      assert.isDefined(onElicitation);
      const abortController = new AbortController();
      const firstResultPromise = onElicitation!(ELICITATION_REQUEST, {
        signal: abortController.signal,
      });
      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag === "None") return;
      assert.equal(requested.value.type, "user-input.requested");
      const secondResultPromise = onElicitation!(ELICITATION_REQUEST, {
        signal: abortController.signal,
      });
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
      yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.makeUnsafe("elicitation-1"), {
        token: "secret-value",
      });
      const [firstResult, secondResult] = yield* Effect.promise(() =>
        Promise.all([firstResultPromise, secondResultPromise]),
      );
      assert.deepEqual(firstResult, { action: "accept", content: { token: "secret-value" } });
      assert.deepEqual(secondResult, firstResult);
      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag === "None") return;
      assert.equal(resolved.value.type, "user-input.resolved");
      assert.deepEqual(resolved.value.payload, { answers: { token: "[redacted]" } });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("cancels elicitation on timeout", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const onElicitation = harness.getLastCreateQueryInput()?.options.onElicitation;
      assert.isDefined(onElicitation);
      const resultPromise = onElicitation!(ELICITATION_REQUEST, {
        signal: new AbortController().signal,
      });
      yield* Stream.runHead(adapter.streamEvents);
      yield* TestClock.adjust("2 minutes");
      assert.deepEqual(yield* Effect.promise(() => resultPromise), { action: "cancel" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("cancels elicitation on interrupt and session stop", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const onElicitation = harness.getLastCreateQueryInput()?.options.onElicitation;
      assert.isDefined(onElicitation);
      const interrupted = onElicitation!(ELICITATION_REQUEST, {
        signal: new AbortController().signal,
      });
      yield* Stream.runHead(adapter.streamEvents);
      yield* adapter.interruptTurn(THREAD_ID);
      assert.deepEqual(yield* Effect.promise(() => interrupted), { action: "cancel" });

      const stopped = onElicitation!(
        { ...ELICITATION_REQUEST, elicitationId: "elicitation-stop" },
        { signal: new AbortController().signal },
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* adapter.stopSession(THREAD_ID);
      assert.deepEqual(yield* Effect.promise(() => stopped), { action: "cancel" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("blocks a new turn while elicitation is pending", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const onElicitation = harness.getLastCreateQueryInput()?.options.onElicitation;
      assert.isDefined(onElicitation);
      const resultPromise = onElicitation!(ELICITATION_REQUEST, {
        signal: new AbortController().signal,
      });
      yield* Stream.runHead(adapter.streamEvents);
      const failure = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "continue", attachments: [] })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
        );
      assert.isDefined(failure);
      if (failure) assert.include(failure.message, "Resolve or cancel the pending");
      yield* adapter.interruptTurn(THREAD_ID);
      assert.deepEqual(yield* Effect.promise(() => resultPromise), { action: "cancel" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("cancels elicitation when stream recovery loses the callback", () => {
    const harness = makeHarness();
    harness.query.setInitializationResponse({} as never);
    harness.query.reopenOnReinitialize = true;
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
      const onElicitation = harness.getLastCreateQueryInput()?.options.onElicitation;
      assert.isDefined(onElicitation);
      const resultPromise = onElicitation!(ELICITATION_REQUEST, {
        signal: new AbortController().signal,
      });
      yield* Stream.runHead(adapter.streamEvents);
      harness.query.fail(new Error("transport lost"));
      for (
        let attempt = 0;
        attempt < 20 && harness.query.reinitializeCalls.length === 0;
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }
      assert.equal(harness.query.reinitializeCalls.length, 1);
      assert.deepEqual(yield* Effect.promise(() => resultPromise), { action: "cancel" });
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("fails startup when the required bridge is unavailable", () => {
    const harness = makeHarness();
    harness.query.mcpServerStatusesResult = [
      { name: "bigbud_orchestration", status: "failed" },
      { name: "docs", status: "connected" },
    ];
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const failure = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
        );
      assert.isDefined(failure);
      if (!failure) return;
      assert.include(failure.message, "Required Claude MCP bridge is unavailable");
      assert.equal(harness.query.closeCalls, 1);
      assert.isFalse(yield* adapter.hasSession(THREAD_ID));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps optional servers nonblocking and protects required controls", () => {
    const harness = makeHarness();
    harness.query.mcpServerStatusesResult = [
      { name: "bigbud_orchestration", status: "connected" },
      { name: "docs", status: "pending" },
    ];
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(harness.query.mcpServerStatusCalls.length, 1);
      assert.isDefined(adapter.mcp);
      if (!adapter.mcp) return;
      yield* adapter.mcp.refresh(THREAD_ID);
      assert.equal(harness.query.mcpServerStatusCalls.length, 2);
      const toggleFailure = yield* adapter.mcp
        .toggle(THREAD_ID, "bigbud_orchestration", false)
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
        );
      assert.isDefined(toggleFailure);
      assert.deepEqual(harness.query.toggleMcpServerCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
