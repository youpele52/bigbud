import { assert, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { TestClock } from "effect/testing";

import { makeKeyedDrainableWorkers } from "./keyedDrainableWorkers";

it.effect("idle per-key workers are closed and recreated on demand without losing order", () =>
  Effect.gen(function* () {
    const processed: Array<string> = [];
    const workers = yield* makeKeyedDrainableWorkers(
      (item: string) => Effect.sync(() => processed.push(item)),
      { idleTtlMs: 1_000, sweep: false },
    );

    for (let index = 0; index < 500; index += 1) yield* workers.enqueue(`thread-${index}`, "a");
    yield* workers.drain;
    assert.strictEqual(workers.size(), 500);

    // Not idle long enough yet: nothing is evicted.
    yield* TestClock.adjust("999 millis");
    assert.strictEqual(yield* workers.evictIdle, 0);
    yield* TestClock.adjust("1 millis");
    assert.strictEqual(yield* workers.evictIdle, 500);
    assert.strictEqual(workers.size(), 0);

    // The next item for an evicted key gets a fresh worker; per-key order holds.
    processed.length = 0;
    for (const item of ["b1", "b2", "b3"]) yield* workers.enqueue("thread-7", item);
    yield* workers.drain;
    assert.deepEqual(processed, ["b1", "b2", "b3"]);
    assert.strictEqual(workers.size(), 1);
  }),
);

it.effect("a worker with queued or running items is never evicted", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const processed: Array<string> = [];
    const workers = yield* makeKeyedDrainableWorkers(
      (item: string) =>
        (item === "slow" ? Deferred.await(gate) : Effect.void).pipe(
          Effect.andThen(Effect.sync(() => processed.push(item))),
        ),
      { idleTtlMs: 0, sweep: false },
    );
    yield* workers.enqueue("thread-1", "slow");
    yield* workers.enqueue("thread-1", "after");
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 hour");
    assert.strictEqual(yield* workers.evictIdle, 0);
    yield* Deferred.succeed(gate, undefined);
    yield* workers.drain;
    assert.deepEqual(processed, ["slow", "after"]);
    assert.strictEqual(yield* workers.evictIdle, 1);
  }),
);
