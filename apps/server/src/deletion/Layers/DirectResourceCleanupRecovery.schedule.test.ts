import { assert, it } from "@effect/vitest";
import { Clock, Effect, Ref } from "effect";
import { TestClock } from "effect/testing";

import { repeatDirectResourceCleanupRecovery } from "./DirectResourceCleanupRecovery.ts";

it.effect("spaces recovery passes after a slow pass completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const starts = yield* Ref.make<ReadonlyArray<number>>([]);
      const running = yield* Ref.make(0);
      const maximumRunning = yield* Ref.make(0);
      const pass = Effect.gen(function* () {
        const active = yield* Ref.updateAndGet(running, (count) => count + 1);
        yield* Ref.update(maximumRunning, (maximum) => Math.max(maximum, active));
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Ref.update(starts, (values) => [...values, startedAt]);
        yield* Effect.sleep("10 seconds");
        yield* Ref.update(running, (count) => count - 1);
      });

      yield* repeatDirectResourceCleanupRecovery(pass).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(starts), [0]);

      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(starts), [0]);
      yield* TestClock.adjust("4999 millis");
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(starts), [0]);
      yield* TestClock.adjust("1 milli");
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(starts), [0, 15_000]);
      assert.equal(yield* Ref.get(maximumRunning), 1);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);
