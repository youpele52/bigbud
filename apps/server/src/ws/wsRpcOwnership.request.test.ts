import { assert, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { awaitOwnershipCondition, makeRpcOwnershipHarness } from "./wsRpcOwnership.test.harness";

it.effect("an opt-in unary deadline cancels and finalizes the actual server request", () =>
  Effect.gen(function* () {
    const h = yield* makeRpcOwnershipHarness();
    yield* h.client.config({ mode: "healthy" }).pipe(Stream.runDrain, Effect.forkScoped);
    yield* awaitOwnershipCondition(() => h.state.activeHealthy === 1);
    const request = yield* Effect.scoped(h.client.slowUnary()).pipe(
      Effect.timeout("15 seconds"),
      Effect.forkScoped,
    );
    yield* awaitOwnershipCondition(() => h.state.activeUnary === 1);
    yield* TestClock.adjust("15 seconds");
    const exit = yield* Fiber.await(request);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) assert.isTrue(Cause.isTimeoutError(Cause.squash(exit.cause)));
    yield* awaitOwnershipCondition(() => h.state.activeUnary === 0);
    assert.equal(h.state.unaryFinalizers, 1);
    assert.equal(h.state.activeHealthy, 1);
    assert.equal(
      h.state.received.filter(
        (message) => message._tag === "Request" && message.tag === "slowUnary",
      ).length,
      1,
    );
    assert.isTrue(h.state.received.some((message) => message._tag === "Interrupt"));
  }),
);

it.effect("a finite stream consumer failure finalizes its actual server producer", () =>
  Effect.gen(function* () {
    const h = yield* makeRpcOwnershipHarness();
    const exit = yield* Effect.scoped(
      Stream.runForEach(h.client.config({ mode: "healthy" }), () =>
        Effect.die(new Error("finite consumer failed")),
      ),
    ).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    yield* awaitOwnershipCondition(() => h.state.activeHealthy === 0);
    assert.equal(h.state.finalizers, 1);
  }),
);

it.effect(
  "a first-applied-snapshot deadline cancels an actual producer without a first value",
  () =>
    Effect.gen(function* () {
      const h = yield* makeRpcOwnershipHarness();
      const applied = yield* Deferred.make<void>();
      const consume = Stream.runForEach(h.client.config({ mode: "async" }), () =>
        Deferred.succeed(applied, undefined),
      );
      const initialApplication = Deferred.await(applied).pipe(
        Effect.timeout("15 seconds"),
        Effect.andThen(Effect.never),
      );
      const request = yield* Effect.scoped(Effect.raceFirst(consume, initialApplication)).pipe(
        Effect.forkScoped,
      );
      yield* awaitOwnershipCondition(() => h.state.activeBad === 1);
      yield* TestClock.adjust("15 seconds");
      const exit = yield* Fiber.await(request);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.isTrue(Cause.isTimeoutError(Cause.squash(exit.cause)));
      yield* awaitOwnershipCondition(() => h.state.activeBad === 0);
      assert.equal(h.state.finalizers, 1);
    }),
);

it.effect("retiring an RPC waiter does not cancel or replay an already admitted command", () =>
  Effect.gen(function* () {
    const h = yield* makeRpcOwnershipHarness();
    const waiter = yield* h.client.acceptedCommand().pipe(Effect.forkScoped);
    yield* Deferred.await(h.commandEnqueued);
    yield* h.inject({ _tag: "Defect", defect: "physical protocol retired" });
    assert.isTrue(Exit.isFailure(yield* Fiber.await(waiter)));
    assert.equal(h.state.acceptedRuns, 0);
    yield* h.commandGate.signalCommandReady;
    yield* awaitOwnershipCondition(() => h.state.acceptedRuns === 1);
    assert.equal(
      h.state.received.filter(
        (message) => message._tag === "Request" && message.tag === "acceptedCommand",
      ).length,
      1,
    );
  }),
);
