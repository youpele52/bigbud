/**
 * In-process count of background maintenance ticks that are running SQL right now (thread
 * retention upkeep, deferred cleanup). Every one of them shares the single SQLite worker, so
 * event-log maintenance treats a running one as soft load and waits for its next tick.
 *
 * @module backgroundSqlActivity
 */
import { Effect } from "effect";

let active = 0;

export const backgroundSqlActivityCount = (): number => active;

/** Counts `effect` as background SQL work while it runs, however it ends. */
export const withBackgroundSqlActivity = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      active += 1;
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        active -= 1;
      }),
  );
