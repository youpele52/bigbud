import { assert, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  runThreadRetentionSchedule,
  runThreadRetentionScheduledTick,
} from "./ThreadRetention.scheduler.ts";

it.effect("Never performs recovery but no retention selection", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* runThreadRetentionScheduledTick({
      auditAndResume: Ref.update(events, (current) => [...current, "recovery"]),
      getPolicy: Effect.succeed("never"),
      enqueue: () => Ref.update(events, (current) => [...current, "selection"]),
      isDisabled: () => false,
      isAutomaticRolloutEnabled: () => true,
    });
    assert.deepEqual(yield* Ref.get(events), ["recovery"]);
  }),
);

it.effect("prioritizes purge recovery before scheduling retention", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* runThreadRetentionScheduledTick({
      auditAndResume: Ref.update(events, (current) => [...current, "recovery"]),
      getPolicy: Effect.succeed("7-days"),
      enqueue: () => Ref.update(events, (current) => [...current, "selection"]),
      isDisabled: () => false,
      isAutomaticRolloutEnabled: () => true,
    });
    assert.deepEqual(yield* Ref.get(events), ["recovery", "selection"]);
  }),
);

it.effect("rechecks the kill switch after recovery", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    let disabled = false;
    yield* runThreadRetentionScheduledTick({
      auditAndResume: Ref.update(events, (current) => {
        disabled = true;
        return [...current, "recovery"];
      }),
      getPolicy: Effect.succeed("7-days"),
      enqueue: () => Ref.update(events, (current) => [...current, "selection"]),
      isDisabled: () => disabled,
      isAutomaticRolloutEnabled: () => true,
    });
    assert.deepEqual(yield* Ref.get(events), ["recovery"]);
  }),
);

it.effect("keeps scheduled selection behind the internal rollout gate", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* runThreadRetentionScheduledTick({
      auditAndResume: Ref.update(events, (current) => [...current, "recovery"]),
      getPolicy: Effect.succeed("7-days"),
      enqueue: () => Ref.update(events, (current) => [...current, "selection"]),
      isDisabled: () => false,
      isAutomaticRolloutEnabled: () => false,
    });
    assert.deepEqual(yield* Ref.get(events), ["recovery"]);
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
