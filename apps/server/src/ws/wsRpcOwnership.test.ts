import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Stream } from "effect";

import { awaitOwnershipCondition, makeRpcOwnershipHarness } from "./wsRpcOwnership.test.harness";

it.effect(
  "finalizes immediately invalid producers before each failed replacement while a sibling stays live",
  () =>
    Effect.gen(function* () {
      const h = yield* makeRpcOwnershipHarness();
      const healthyValues: Array<number> = [];
      const healthy = yield* h.client.config({ mode: "healthy" }).pipe(
        Stream.runForEach((value) =>
          Effect.sync(() => {
            healthyValues.push(value);
          }),
        ),
        Effect.forkScoped,
      );
      yield* awaitOwnershipCondition(() => healthyValues.length === 1);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const bad = yield* h.client
          .config({ mode: "immediate" })
          .pipe(Stream.runDrain, Effect.forkScoped);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(bad)));
        assert.equal(h.state.activeBad, 0);
        assert.equal(h.state.activeHealthy, 1);
      }
      assert.equal(h.state.maximumBad, 1);
      assert.deepEqual(h.state.badActiveAtFailure, [0, 0, 0]);
      yield* h.publishHealthy(2);
      yield* awaitOwnershipCondition(() => healthyValues.length === 2);
      assert.deepEqual(healthyValues, [1, 2]);
      yield* Fiber.interrupt(healthy);
      yield* awaitOwnershipCondition(() => h.state.activeHealthy === 0);
    }),
);

it.effect("finalizes asynchronous encoding failures before delivering the failure exit", () =>
  Effect.gen(function* () {
    const h = yield* makeRpcOwnershipHarness();
    const bad = yield* h.client.config({ mode: "async" }).pipe(Stream.runDrain, Effect.forkScoped);
    yield* awaitOwnershipCondition(() => h.state.activeBad === 1);
    yield* Deferred.succeed(h.releaseBad, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(bad)));
    assert.equal(h.state.activeBad, 0);
    assert.deepEqual(h.state.badActiveAtFailure, [0]);
  }),
);

it.effect(
  "keeps healthy subscriptions usable after unary encoding and synchronous factory failures",
  () =>
    Effect.gen(function* () {
      const h = yield* makeRpcOwnershipHarness();
      const values: Array<number> = [];
      yield* h.client.config({ mode: "healthy" }).pipe(
        Stream.runForEach((value) =>
          Effect.sync(() => {
            values.push(value);
          }),
        ),
        Effect.forkScoped,
      );
      yield* awaitOwnershipCondition(() => values.length === 1);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(h.client.unary())));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(Stream.runDrain(h.client.config({ mode: "factoryThrow" }))),
        ),
      );
      assert.equal(h.state.activeHealthy, 1);
      yield* h.publishHealthy(2);
      yield* awaitOwnershipCondition(() => values.length === 2);
    }),
);

it.effect("cancels a producer blocked waiting for an Ack", () =>
  Effect.gen(function* () {
    const h = yield* makeRpcOwnershipHarness({ dropAcks: true });
    let values = 0;
    const stream = yield* h.client.config({ mode: "healthy" }).pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          values += 1;
        }),
      ),
      Effect.forkScoped,
    );
    yield* awaitOwnershipCondition(() => values === 1);
    yield* Fiber.interrupt(stream);
    yield* awaitOwnershipCondition(() => h.state.activeHealthy === 0);
    assert.equal(h.state.finalizers, 1);
  }),
);

it.effect("forwards decode-failure cancellation through both ownership maps", () =>
  Effect.gen(function* () {
    const h = yield* makeRpcOwnershipHarness({ corruptChunks: true });
    const stream = yield* h.client
      .config({ mode: "healthy" })
      .pipe(Stream.runDrain, Effect.forkScoped);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(stream)));
    yield* awaitOwnershipCondition(() => h.state.activeHealthy === 0);
    assert.isTrue(h.state.received.some((message) => message._tag === "Interrupt"));
    assert.equal(h.state.finalizers, 1);
    const healthyValues: Array<number> = [];
    yield* h.client.config({ mode: "healthy" }).pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          healthyValues.push(value);
        }),
      ),
      Effect.forkScoped,
    );
    yield* awaitOwnershipCondition(() => healthyValues.length === 1);
    yield* h.publishHealthy(2);
    yield* awaitOwnershipCondition(() => healthyValues.length === 2);
    assert.deepEqual(healthyValues, [1, 2]);
  }),
);

it.effect("cancels every actual server producer on a global defect", () =>
  Effect.gen(function* () {
    const h = yield* makeRpcOwnershipHarness();
    const first = yield* h.client
      .config({ mode: "healthy" })
      .pipe(Stream.runDrain, Effect.forkScoped);
    const second = yield* h.client
      .config({ mode: "healthy" })
      .pipe(Stream.runDrain, Effect.forkScoped);
    yield* awaitOwnershipCondition(() => h.state.activeHealthy === 2);
    yield* h.inject({ _tag: "Defect", defect: "global failure" });
    assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
    assert.isTrue(Exit.isFailure(yield* Fiber.await(second)));
    yield* awaitOwnershipCondition(() => h.state.activeHealthy === 0);
    assert.equal(h.state.finalizers, 2);
  }),
);

it.effect("cancels actual server producers after malformed socket frames", () =>
  Effect.gen(function* () {
    const h = yield* makeRpcOwnershipHarness();
    const stream = yield* h.client
      .config({ mode: "healthy" })
      .pipe(Stream.runDrain, Effect.forkScoped);
    yield* awaitOwnershipCondition(() => h.state.activeHealthy === 1);
    yield* h.injectRaw("{invalid-json");
    assert.isTrue(Exit.isFailure(yield* Fiber.await(stream)));
    yield* awaitOwnershipCondition(() => h.state.activeHealthy === 0);
  }),
);
