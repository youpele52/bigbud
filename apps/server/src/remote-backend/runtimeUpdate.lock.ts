import { Effect, Semaphore } from "effect";

/**
 * The single-flight update lock. Every runtime archive store call runs under it, and the store
 * receives `checkpoint` (lock held + backend ownership) as its assertion between durable steps.
 */
export const makeRuntimeUpdateLock = Effect.fn("makeRuntimeUpdateLock")(function* (
  assertOwner?: () => Promise<void>,
) {
  const semaphore = yield* Semaphore.make(1);
  let held = false;
  const checkpoint = async () => {
    if (!held) throw new Error("The runtime update single-flight lock is not held.");
    await assertOwner?.();
  };
  const withLock = <A, E, R>(
    use: (checkpoint: () => Promise<void>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    semaphore.withPermit(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          held = true;
        }),
        () => use(checkpoint),
        () =>
          Effect.sync(() => {
            held = false;
          }),
      ),
    );
  return { withLock, checkpoint };
});

export type RuntimeUpdateLock = Effect.Success<ReturnType<typeof makeRuntimeUpdateLock>>;
