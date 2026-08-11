import { Duration, Effect } from "effect";
import * as Semaphore from "effect/Semaphore";

export const PROVIDER_PROBE_CONCURRENCY = 3;
export const PROVIDER_PROBE_TIMEOUT = "12 seconds";

const aggregateProbeSemaphore = Effect.runSync(Semaphore.make(PROVIDER_PROBE_CONCURRENCY));

export const withProviderProbePermit = <A, E, R>(
  semaphore: Semaphore.Semaphore,
  probe: Effect.Effect<A, E, R>,
  timeout: Duration.Input,
) => semaphore.withPermits(1)(probe.pipe(Effect.timeoutOption(timeout)));

export const runCoordinatedProviderProbe = <A, E, R>(
  probe: Effect.Effect<A, E, R>,
  timeout: Duration.Input = PROVIDER_PROBE_TIMEOUT,
) => withProviderProbePermit(aggregateProbeSemaphore, probe, timeout);
