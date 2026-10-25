import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { Deferred, Effect } from "effect";
import type { ProviderRegistration } from "./ProviderRegistration.ts";

/** Includes healthy providers even when another provider needs recovery. */
export function refreshSubscriptionProviders(
  registrations: ReadonlyArray<ProviderRegistration>,
  providers: ReadonlyArray<ServerProvider>,
) {
  return Effect.forEach(
    registrations.filter(
      (entry) =>
        entry.service.refreshUsageLimits &&
        providers.some((provider) => provider.provider === entry.provider && provider.enabled),
    ),
    (entry) => entry.service.refreshUsageLimits!.pipe(Effect.ignoreCause({ log: true })),
    { concurrency: "unbounded", discard: true },
  );
}

/** Shares only in-flight work: every subsequent manual refresh performs new reads. */
export function singleFlightUsageRefresh<A>(read: Effect.Effect<A>): Effect.Effect<A> {
  let pending: Deferred.Deferred<A> | undefined;
  return Effect.suspend(() => {
    if (pending) return Deferred.await(pending);
    const current = Deferred.makeUnsafe<A>();
    pending = current;
    return read.pipe(
      Effect.onExit((exit) =>
        Deferred.done(current, exit).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pending = undefined;
            }),
          ),
        ),
      ),
    );
  });
}
