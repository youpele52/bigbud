import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { makeDeterministicRandomService, makeHarness, THREAD_ID } from "./Adapter.test.helpers.ts";

describe("Claude turn safety", () => {
  it.effect("rejects an ordinary overlapping turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] });
      const result = yield* Effect.exit(
        adapter.sendTurn({ threadId: THREAD_ID, input: "second", attachments: [] }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(harness.query.interruptCalls.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores a stale interrupt turn id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "first",
        attachments: [],
      });
      yield* adapter.interruptTurn(THREAD_ID, "stale-turn" as never);
      assert.equal(harness.query.interruptCalls.length, 0);
      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      assert.equal(harness.query.interruptCalls.length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("fails and clears the active turn for a malformed result", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const events = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first", attachments: [] });
      harness.query.emitUnchecked({ type: "result", subtype: "success" });
      const runtimeEvents = Array.from(yield* Fiber.join(events));
      const completion = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completion?.type, "turn.completed");
      if (completion?.type === "turn.completed") assert.equal(completion.payload.state, "failed");
      const next = yield* Effect.exit(
        adapter.sendTurn({ threadId: THREAD_ID, input: "second", attachments: [] }),
      );
      assert.equal(next._tag, "Success");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
