import * as ServiceMap from "effect/ServiceMap";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/** Application-owned cancellation, rather than process exit or an external PID signal. */
export class OwnershipShutdown extends ServiceMap.Service<
  OwnershipShutdown,
  { readonly request: () => void }
>()("bigbud/OwnershipShutdown") {}

/** Race completion interrupts the launch fiber and awaits its scoped finalizers. */
export function withOwnershipShutdown<A, E, R>(
  application: Effect.Effect<A, E, R | OwnershipShutdown>,
) {
  return Effect.gen(function* () {
    const stopped = yield* Deferred.make<void>();
    return yield* application.pipe(
      Effect.provideService(OwnershipShutdown, {
        request: () => {
          // Repeated accepted commits are idempotent; only the first completes this deferred.
          Deferred.doneUnsafe(stopped, Effect.void);
        },
      }),
      Effect.raceFirst(Deferred.await(stopped)),
    );
  });
}
