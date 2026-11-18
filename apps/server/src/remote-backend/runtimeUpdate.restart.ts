/**
 * The backend-unit restart request of a runtime update (M3 WP-4D), shared by activation and
 * rollback.
 *
 * Once a restart has been requested (or may have been), this runtime never restores the previous
 * config: systemd may already be restarting the unit, and the next start would then run whatever
 * the config names. Instead the journal stays as written and the next runtime's trial decides
 * (the staged graph passes or rolls back; the old graph fails the "not the staged runtime" check
 * and rolls back). A runtime that is still alive after a grace period was evidently not
 * restarted, so it repeats the idempotent request, a bounded number of times. Shutdown
 * interrupts the wait, so nothing here runs while the unit is stopping.
 */
import { Duration, Effect } from "effect";

import { promise, type RuntimeUpdateActivationContext } from "./runtimeUpdate.activate.context.ts";

/** Longer than the unit's `TimeoutStopSec=15` plus a start, so a slow stop is not re-requested. */
export const RUNTIME_UPDATE_RESTART_GRACE_MS = 60_000;
const RESTART_REQUESTS = 5;

/** One request; fails only when nothing was queued (`RuntimeUnitRestartRefused`). */
export const requestBackendRestart = Effect.fn("RuntimeUpdate.requestRestart")(function* (
  ctx: RuntimeUpdateActivationContext,
) {
  const outcome = yield* promise(() => ctx.unit.restart());
  if (outcome === "unconfirmed")
    yield* Effect.logWarning(
      "The backend restart request lost its reply; treating it as requested (the next start decides)",
    );
  return outcome;
});

/** After a request: wait to be stopped; while still running, repeat the request. Never restores. */
export const superviseBackendRestart = Effect.fn("RuntimeUpdate.superviseRestart")(function* (
  ctx: RuntimeUpdateActivationContext,
) {
  const grace = Duration.millis(ctx.restartGraceMs ?? RUNTIME_UPDATE_RESTART_GRACE_MS);
  for (let attempt = 2; attempt <= RESTART_REQUESTS; attempt++) {
    yield* Effect.sleep(grace);
    yield* Effect.logWarning("The backend unit has not restarted yet; requesting it again", {
      attempt,
    });
    const again = yield* requestBackendRestart(ctx).pipe(Effect.result);
    if (again._tag === "Failure")
      yield* Effect.logWarning("The repeated restart request failed", again.failure);
  }
  yield* Effect.sleep(grace);
  yield* Effect.logError(
    "The backend unit did not restart after repeated requests. Restart it to finish the update; the next start's trial decides.",
  );
});
