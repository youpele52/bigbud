import { Deferred, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { runOwnedWorktreeOperation } from "./wsWorktreeOwnedOperation.ts";

it("rejects mutation when no long-lived server owner is available", async () => {
  let dispatched = false;
  await expect(
    Effect.runPromise(
      runOwnedWorktreeOperation(
        undefined,
        Effect.sync(() => {
          dispatched = true;
        }),
      ),
    ),
  ).rejects.toThrow("Nothing was dispatched");
  expect(dispatched).toBe(false);
});

it("a disconnected RPC waiter cannot cancel an accepted server-owned mutation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const admitted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const mutation = Effect.gen(function* () {
          yield* Deferred.succeed(admitted, undefined);
          yield* Deferred.await(release);
          yield* Deferred.succeed(completed, undefined);
        });
        const waiter = yield* runOwnedWorktreeOperation(scope, mutation).pipe(Effect.forkScoped);
        yield* Deferred.await(admitted);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(completed);
        expect(yield* Deferred.isDone(completed)).toBe(true);
      }),
    ).pipe(Effect.timeout("5 seconds")),
  );
});
