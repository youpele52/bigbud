import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Option, ServiceMap } from "effect";

/**
 * V2 request authority, caller fences and settlement marks live in AsyncLocalStorage, but
 * Effect's scheduler batches fiber resumptions: after any async step (journal SQL is answered on
 * a worker) a fiber may continue with no, or another caller's, async context. Capture the context
 * where an Effect is started and re-enter it inside the promise callbacks that Effect runs.
 */
export function captureV2AsyncContext(): <T>(run: () => T) => T {
  const snapshot = AsyncLocalStorage.snapshot();
  return (run) => snapshot(run);
}

/** Fiber-local carrier for the starting caller's async context; it survives Effect scheduling. */
export class V2CallerAsyncContext extends ServiceMap.Service<
  V2CallerAsyncContext,
  { readonly enter: <T>(run: () => T) => T }
>()("bigbud/OpencodeV2/V2CallerAsyncContext") {}

/** Start `effect` with the current caller's async context; call it where the Effect is run. */
export const withV2CallerAsyncContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, V2CallerAsyncContext, { enter: captureV2AsyncContext() });

const passThrough = <T>(run: () => T): T => run();

/** Re-enters the provided caller context; without a provider, callbacks run as before. */
export const v2CallerContextEntry = Effect.map(
  Effect.serviceOption(V2CallerAsyncContext),
  Option.match({ onNone: () => passThrough, onSome: (caller) => caller.enter }),
);

export const v2TryPromise = <A, E>(options: {
  readonly try: (signal: AbortSignal) => PromiseLike<A>;
  readonly catch: (error: unknown) => E;
}) =>
  Effect.flatMap(v2CallerContextEntry, (enter) =>
    Effect.tryPromise({ try: (signal) => enter(() => options.try(signal)), catch: options.catch }),
  );

export const v2Promise = <A>(run: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.flatMap(v2CallerContextEntry, (enter) =>
    Effect.promise((signal) => enter(() => run(signal))),
  );
