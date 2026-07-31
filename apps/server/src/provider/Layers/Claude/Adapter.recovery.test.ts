import { describe, it, assert } from "@effect/vitest";
import { Effect, Random } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { THREAD_ID, makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";

describe("ClaudeAdapter recovery", () => {
  it.effect("reinitializes a transient stream failure without closing the session", () => {
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
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("transient stream failure"));
      for (
        let attempt = 0;
        attempt < 20 && harness.query.reinitializeCalls.length === 0;
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }

      assert.equal(harness.query.reinitializeCalls.length, 1);
      for (
        let attempt = 0;
        attempt < 20 && harness.query.mcpServerStatusCalls.length < 2;
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }
      assert.equal(harness.query.mcpServerStatusCalls.length, 2);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
