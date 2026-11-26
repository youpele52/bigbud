import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import type { SubscriptionRefreshOutcome } from "@bigbud/contracts/server/usageLimits.ts";
import { Deferred, type Duration, Effect, Option } from "effect";
import type { ProviderRegistration } from "./ProviderRegistration.ts";

// Five readers in this release. Keep them independent; allow time for Muse's
// host startup, teardown, and CLI fallback without waiting forever on a hung reader.
const USAGE_REFRESH_CONCURRENCY = 5;
const USAGE_READER_TIMEOUT = "60 seconds";

/** Includes healthy providers even when another provider needs recovery. */
export function refreshSubscriptionProviders(
  registrations: ReadonlyArray<ProviderRegistration>,
  providers: ReadonlyArray<ServerProvider>,
  timeout: Duration.Input = USAGE_READER_TIMEOUT,
) {
  const enabled = new Set(providers.filter((provider) => provider.enabled).map((p) => p.provider));
  const readers = registrations.flatMap(({ provider, service }) =>
    enabled.has(provider) && service.refreshUsageLimits
      ? [{ provider, read: service.refreshUsageLimits }]
      : [],
  );
  return Effect.forEach(
    readers,
    ({ provider, read }) =>
      read.pipe(
        Effect.map(({ status }) => status),
        Effect.catchCause(() =>
          Effect.logWarning("Subscription usage reader failed", { provider }).pipe(
            Effect.as("failed" as const),
          ),
        ),
        Effect.timeoutOption(timeout),
        Effect.map(
          (status): SubscriptionRefreshOutcome => ({
            provider,
            status: Option.getOrElse(status, () => "timed-out"),
          }),
        ),
      ),
    { concurrency: USAGE_REFRESH_CONCURRENCY },
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
