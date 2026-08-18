import { assert, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  runThreadRetentionSchedule,
  runThreadRetentionScheduledTick,
} from "./ThreadRetention.scheduler.ts";

it.effect("does not run when the policy is never", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* runThreadRetentionScheduledTick({
      getPolicy: Effect.succeed("never"),
      run: () => Ref.update(events, (current) => [...current, "selection"]),
      isDisabled: () => false,
    });
    assert.deepEqual(yield* Ref.get(events), []);
  }),
);

it.effect("runs finite policies immediately", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* runThreadRetentionScheduledTick({
      getPolicy: Effect.succeed("7-days"),
      run: () => Ref.update(events, (current) => [...current, "selection"]),
      isDisabled: () => false,
    });
    assert.deepEqual(yield* Ref.get(events), ["selection"]);
  }),
);

it.effect("does not run when disabled", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const disabled = true;
    yield* runThreadRetentionScheduledTick({
      getPolicy: Effect.succeed("7-days"),
      run: () => Ref.update(events, (current) => [...current, "selection"]),
      isDisabled: () => disabled,
    });
    assert.deepEqual(yield* Ref.get(events), []);
  }),
);

it.effect("schedules finite policies without an internal rollout gate", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* runThreadRetentionScheduledTick({
      getPolicy: Effect.succeed("7-days"),
      run: () => Ref.update(events, (current) => [...current, "selection"]),
      isDisabled: () => false,
    });
    assert.deepEqual(yield* Ref.get(events), ["selection"]);
  }),
);

it.effect("waits ten minutes and remains scope-cancellable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const count = yield* Ref.make(0);
      const fiber = yield* runThreadRetentionSchedule(Ref.update(count, (value) => value + 1)).pipe(
        Effect.forkScoped,
      );
      yield* TestClock.adjust(Duration.millis(599_000));
      assert.equal(yield* Ref.get(count), 0);
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 1);
      yield* Fiber.interrupt(fiber);
    }),
  ),
);

it.effect("continues daily scheduling after a transient tick failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const count = yield* Ref.make(0);
      const tick = Ref.updateAndGet(count, (value) => value + 1).pipe(
        Effect.flatMap((value) =>
          value === 1 ? Effect.fail(new Error("transient")) : Effect.void,
        ),
      );
      const fiber = yield* runThreadRetentionSchedule(tick).pipe(Effect.forkScoped);
      yield* TestClock.adjust("10 minutes");
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 1);
      yield* TestClock.adjust("24 hours");
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 2);
      yield* Fiber.interrupt(fiber);
    }),
  ),
);
