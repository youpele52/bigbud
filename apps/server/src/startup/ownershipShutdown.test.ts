import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { OwnershipShutdown, withOwnershipShutdown } from "./ownershipShutdown";

it("cooperative shutdown awaits scoped finalizers in reverse acquisition order", async () => {
  const events: string[] = [];
  const application = Effect.gen(function* () {
    const shutdown = yield* OwnershipShutdown;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        events.push("lock");
      }),
      () =>
        Effect.sync(() => {
          events.push("unlock");
        }),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        events.push("persistence");
      }),
      () =>
        Effect.promise(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push("persistence-closed");
        }),
    );
    shutdown.request();
    return yield* Effect.never;
  }).pipe(Effect.scoped);
  await Effect.runPromise(withOwnershipShutdown(application));
  expect(events).toEqual(["lock", "persistence", "persistence-closed", "unlock"]);
});
