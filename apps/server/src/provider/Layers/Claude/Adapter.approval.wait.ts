import { Deferred, Effect, type Fiber } from "effect";

/** Each SDK delivery owns its signal; aborting a duplicate must not cancel its owner. */
export const awaitClaudeCallback = <A>(
  signal: AbortSignal,
  wait: Effect.Effect<A>,
  cancelled: A,
  runFork: <B, E>(effect: Effect.Effect<B, E>) => Fiber.Fiber<B, E>,
  onAbort: Effect.Effect<unknown> = Effect.void,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const aborted = yield* Deferred.make<void>();
    const listener = () => {
      runFork(Deferred.succeed(aborted, undefined));
    };
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) listener();
      }),
      () =>
        signal.aborted
          ? onAbort.pipe(Effect.as(cancelled))
          : Effect.raceFirst(
              wait,
              Deferred.await(aborted).pipe(Effect.andThen(onAbort), Effect.as(cancelled)),
            ).pipe(
              Effect.flatMap((value) =>
                signal.aborted ? onAbort.pipe(Effect.as(cancelled)) : Effect.succeed(value),
              ),
            ),
      () => Effect.sync(() => signal.removeEventListener("abort", listener)),
    );
  });
