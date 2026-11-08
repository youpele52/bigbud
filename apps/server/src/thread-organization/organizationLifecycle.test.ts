import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import {
  runOrganizationLifecycle,
  OrganizationLimit,
  OrganizationResync,
  type OrganizationAutomationStatus,
} from "./organizationLifecycle.ts";

it.effect("restart attempts close their owning scopes and latch after three failures", () =>
  Effect.gen(function* () {
    let attempts = 0;
    let open = 0;
    const statuses: OrganizationAutomationStatus[] = [];
    const run = Effect.gen(function* () {
      attempts += 1;
      assert.equal(open, 0);
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          open += 1;
        }),
        () =>
          Effect.sync(() => {
            open -= 1;
          }),
      );
      return yield* Effect.fail(new Error("fixture child failure"));
    });
    const fiber = yield* Effect.forkScoped(
      runOrganizationLifecycle({
        run,
        status: (value) => {
          statuses.push(value);
        },
      }),
    );
    yield* TestClock.adjust("2 seconds");
    assert.equal(attempts, 3);
    assert.equal(open, 0);
    assert.equal(statuses.at(-1), "paused");
    yield* TestClock.adjust("1 minute");
    assert.equal(attempts, 3);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("routine resynchronisation does not consume native failure budget", () =>
  Effect.gen(function* () {
    let attempts = 0;
    let open = 0;
    const run = Effect.gen(function* () {
      attempts += 1;
      assert.equal(open, 0);
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          open += 1;
        }),
        () =>
          Effect.sync(() => {
            open -= 1;
          }),
      );
      return yield* Effect.fail(
        attempts <= 4 ? new OrganizationResync("policy changed") : new Error("native failed"),
      );
    });
    const statuses: OrganizationAutomationStatus[] = [];
    const fiber = yield* Effect.forkScoped(
      runOrganizationLifecycle({ run, status: (value) => void statuses.push(value) }),
    );
    // Resyncs are spaced 2s, 4s, 8s, 16s: never a hot loop, never "paused".
    yield* TestClock.adjust("1 second");
    assert.equal(attempts, 1);
    yield* TestClock.adjust("28 seconds");
    assert.equal(attempts, 4);
    assert.notInclude(statuses, "paused");
    yield* TestClock.adjust("3 seconds");
    assert.equal(attempts, 7);
    assert.equal(open, 0);
    yield* TestClock.adjust("1 minute");
    assert.equal(attempts, 7);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("paused recovers on a settings change or after the cooldown, never permanently", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const signals = yield* Queue.unbounded<void>();
    const run = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(new Error("native failed"));
    });
    const fiber = yield* Effect.forkScoped(
      runOrganizationLifecycle({ run, status: () => {}, retry: Queue.take(signals) }),
    );
    yield* TestClock.adjust("2 seconds");
    assert.equal(attempts, 3);
    yield* TestClock.adjust("1 minute");
    assert.equal(attempts, 3);
    // A settings change clears the latch immediately.
    yield* Queue.offer(signals, undefined);
    yield* TestClock.adjust("2 seconds");
    assert.equal(attempts, 6);
    // Without a signal the cooldown (5 minutes) clears it.
    yield* TestClock.adjust("4 minutes");
    assert.equal(attempts, 6);
    yield* TestClock.adjust("2 minutes");
    assert.equal(attempts, 9);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("a terminal limit waits for a settings change only: no cooldown or move retry loop", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const settingsSaved = yield* Queue.unbounded<void>();
    const moved = yield* Queue.unbounded<void>();
    const statuses: Array<[OrganizationAutomationStatus, string | undefined]> = [];
    const run = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(new OrganizationLimit("thread-limit", "too many threads"));
    });
    const fiber = yield* Effect.forkScoped(
      runOrganizationLifecycle({
        run,
        status: (value, reason) => void statuses.push([value, reason]),
        retry: Effect.raceFirst(Queue.take(settingsSaved), Queue.take(moved)),
        explicitRetry: Queue.take(settingsSaved),
      }),
    );
    yield* TestClock.adjust("1 second");
    assert.equal(attempts, 1);
    assert.deepEqual(statuses.at(-1), ["paused", "thread-limit"]);
    // Neither the paused cooldown nor a deliberate move repeats the heavy attempt.
    yield* Queue.offer(moved, undefined);
    yield* TestClock.adjust("1 hour");
    assert.equal(attempts, 1);
    yield* Queue.offer(settingsSaved, undefined);
    yield* TestClock.adjust("1 second");
    assert.equal(attempts, 2);
    assert.deepEqual(statuses.at(-2), ["syncing", undefined]);
    yield* Fiber.interrupt(fiber);
  }),
);
