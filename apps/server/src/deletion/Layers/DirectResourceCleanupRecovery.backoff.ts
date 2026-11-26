import { Clock, Effect } from "effect";

export const COVERAGE_BACKOFF_INITIAL_MS = 5_000;
export const COVERAGE_BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * Gates canonical-pruning baseline coverage attempts. A coverage failure that cannot make
 * progress (for example a projection baseline that cannot be created yet) must not be retried
 * and warned about on every 5s recovery tick; attempts back off exponentially up to 15 minutes,
 * and success resets the delay.
 */
export function makeCoverageBackoff(
  initialMs = COVERAGE_BACKOFF_INITIAL_MS,
  maxMs = COVERAGE_BACKOFF_MAX_MS,
) {
  let nextAttemptAt = 0;
  let delayMs = 0;
  let consecutiveFailures = 0;
  return {
    /** Runs `attempt` only when the backoff window has elapsed; otherwise skips quietly. */
    gate: <E, R>(attempt: Effect.Effect<void, E, R>): Effect.Effect<boolean, E, R> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < nextAttemptAt) return false;
        const exit = yield* Effect.exit(attempt);
        if (exit._tag === "Success") {
          delayMs = 0;
          consecutiveFailures = 0;
          nextAttemptAt = 0;
          return true;
        }
        consecutiveFailures += 1;
        delayMs = delayMs === 0 ? initialMs : Math.min(delayMs * 2, maxMs);
        nextAttemptAt = (yield* Clock.currentTimeMillis) + delayMs;
        return yield* Effect.failCause(exit.cause);
      }),
    retryDelayMs: () => delayMs,
    consecutiveFailures: () => consecutiveFailures,
  };
}

export type CoverageBackoff = ReturnType<typeof makeCoverageBackoff>;
