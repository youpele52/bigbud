import { assert, it } from "@effect/vitest";
import { Duration, Effect, Option, Queue } from "effect";
import { TestClock } from "effect/testing";

import { makeThreadRetentionWakeScheduler } from "./ThreadRetention.runtime.ts";
import { normalThreadRetentionWork, type ThreadRetentionWork } from "./ThreadRetention.worker.ts";

it.effect("deduplicates long-backoff wake sleepers without queueing before nextAttemptAt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workQueue = yield* Queue.unbounded<ThreadRetentionWork>();
      const scope = yield* Effect.scope;
      const { scheduleWake } = yield* makeThreadRetentionWakeScheduler({
        workQueue,
        scope,
        now: () => 0,
      });
      const wakeAt = new Date(Duration.toMillis(Duration.hours(6))).toISOString();

      yield* scheduleWake("backoff-run", wakeAt);
      yield* scheduleWake("backoff-run", wakeAt);
      yield* TestClock.adjust(Duration.millis((5 * 60 + 59) * 60 * 1_000));
      assert.isTrue(Option.isNone(yield* Queue.poll(workQueue)));

      yield* TestClock.adjust("1 minute");
      assert.deepEqual(yield* Queue.take(workQueue), normalThreadRetentionWork);
      assert.isTrue(Option.isNone(yield* Queue.poll(workQueue)));
    }),
  ),
);

it.effect("cancels a stale scoped wake before it can enqueue work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workQueue = yield* Queue.unbounded<ThreadRetentionWork>();
      const { scheduleWake, cancelWake } = yield* makeThreadRetentionWakeScheduler({
        workQueue,
        scope: yield* Effect.scope,
        now: () => 0,
      });
      const wakeAt = new Date(Duration.toMillis(Duration.hours(1))).toISOString();

      yield* scheduleWake("terminal-run", wakeAt, {
        _tag: "freshManual",
        runId: "terminal-run",
      });
      yield* cancelWake("terminal-run");
      yield* TestClock.adjust("1 hour");
      assert.isTrue(Option.isNone(yield* Queue.poll(workQueue)));
    }),
  ),
);
