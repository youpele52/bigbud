/**
 * Bounded, concurrent adapter teardown for `ProviderService` stop-all (server shutdown, desktop
 * quit and update handoff).
 *
 * Each adapter's `stopAll` runs in a detached fiber that is awaited with a timeout, so the wait is
 * bounded even when an adapter's teardown sits in an uninterruptible region. A timed-out adapter is
 * logged and left to finish on its own. The timeout bounds this wait, not the stop: one ACP session
 * stop can take about 4.5 s (see `ACP_SESSION_STOP_WAIT` in `acp/AcpSessionStop.ts`).
 *
 * @module ProviderService.stopAll
 */
import { Duration, Effect, Exit, Fiber, Option } from "effect";

import type { ThreadRecoveryIntentRepositoryShape } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

/** Per-adapter budget. Must stay below the dev launcher's 4 s graceful stop. */
export const PROVIDER_STOP_ALL_ADAPTER_TIMEOUT = Duration.seconds(3);

type StoppableAdapter = Pick<ProviderAdapterShape<ProviderAdapterError>, "provider" | "stopAll">;

const stopAdapterWithin = Effect.fn("stopAdapterWithin")(function* (
  adapter: StoppableAdapter,
  timeout: Duration.Duration,
) {
  const fiber = yield* Effect.forkDetach(adapter.stopAll());
  const exit = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(timeout));
  if (Option.isNone(exit)) {
    yield* Effect.logWarning("provider adapter stopAll timed out; continuing shutdown", {
      provider: adapter.provider,
      timeoutMs: Duration.toMillis(timeout),
    });
    return;
  }
  if (Exit.isFailure(exit.value)) {
    yield* Effect.logWarning("provider adapter stopAll failed; continuing shutdown", {
      provider: adapter.provider,
      cause: exit.value.cause,
    });
  }
});

/** Stop every adapter concurrently; resolves within `timeout` of the slowest adapter starting. */
export const stopAdaptersWithin = Effect.fn("stopAdaptersWithin")(function* (
  adapters: ReadonlyArray<StoppableAdapter>,
  timeout: Duration.Input = PROVIDER_STOP_ALL_ADAPTER_TIMEOUT,
) {
  const budget = Duration.fromInputUnsafe(timeout);
  yield* Effect.forEach(adapters, (adapter) => stopAdapterWithin(adapter, budget), {
    concurrency: "unbounded",
    discard: true,
  });
});

/**
 * App exit suspends every active recovery intent; it never revokes. Nothing resumes a
 * suspended intent in the sleep-and-wake slice. A failed write is logged, never fatal.
 */
export const suspendRecoveryIntentsForStopAll = Effect.fn("suspendRecoveryIntentsForStopAll")(
  function* (repository: Option.Option<ThreadRecoveryIntentRepositoryShape>, reason: string) {
    if (Option.isNone(repository)) return;
    yield* repository.value.suspendActiveForExit({ at: new Date().toISOString() }).pipe(
      Effect.tap((count) =>
        count > 0
          ? Effect.logInfo("suspended recovery intents for exit", { reason, count })
          : Effect.void,
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to suspend recovery intents for exit", { reason, error }),
      ),
    );
  },
);
