import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";

/** A deliberate fresh snapshot (policy/clock/projection change), not a native failure. */
export class OrganizationResync extends Error {}
/** A genuine native/transport fault (child exit, malformed frame, write/ACK timeout). */
export class OrganizationNativeFault extends Data.TaggedError("OrganizationNativeFault")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A deterministic capacity limit (too many threads, or a capture slower than the largest
 * budget). Retrying on a timer would repeat the same heavy pass, so it waits for an explicit
 * retry (a settings change) instead of the paused cooldown.
 */
export class OrganizationLimit extends Error {
  constructor(
    readonly reason: OrganizationLimitReason,
    message: string,
  ) {
    super(message);
  }
}
export type OrganizationLimitReason = "thread-limit" | "capture-time";

export type OrganizationAutomationStatus = "syncing" | "paused";

export const ORGANIZATION_LIFECYCLE = {
  failureWindowMs: 30_000,
  failureLimit: 3,
  /** Paused clears after this cooldown even without a settings change (restart is a hatch). */
  pauseCooldownMs: 300_000,
  resyncMinMs: 2_000,
  resyncMaxMs: 60_000,
  /** An attempt that stayed up this long was healthy: resync pacing starts over. */
  healthyRunMs: 60_000,
} as const;

/** Each attempt owns a scope: it must fence and stop its native child before retrying.
 * Three real failures in 30s latch paused until settings change or the cooldown elapses.
 * Routine resyncs never consume that budget but are spaced (2s doubling to 60s) so flapping
 * barriers or repeated over-budget captures cannot hammer the database. Manual commands never
 * depend on this loop. Healthy status is published by the bridge only after native activation.
 * A terminal `OrganizationLimit` waits for a settings change only, never a timer.
 */
export function runOrganizationLifecycle<E>(input: {
  run: Effect.Effect<never, E, Scope.Scope>;
  status: (status: OrganizationAutomationStatus, reason?: OrganizationLimitReason) => void;
  /** Completes on a settings change or deliberate move (recovery signal for paused). */
  retry?: Effect.Effect<void>;
  /** Completes on a settings change only: the one way out of a terminal limit. */
  explicitRetry?: Effect.Effect<void>;
}) {
  const L = ORGANIZATION_LIFECYCLE;
  return Effect.gen(function* () {
    let failures: number[] = [];
    let resyncs = 0;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      failures = failures.filter((at) => now - at < L.failureWindowMs);
      if (failures.length >= L.failureLimit) {
        input.status("paused");
        yield* Effect.logWarning(
          "Automatic thread organisation is paused; it retries after a settings change or cooldown.",
        );
        yield* Effect.raceFirst(Effect.sleep(L.pauseCooldownMs), input.retry ?? Effect.never);
        failures = [];
        resyncs = 0;
        continue;
      }
      input.status("syncing");
      const result = yield* Effect.result(Effect.scoped(input.run));
      if (Result.isSuccess(result)) return yield* Effect.never;
      const ended = yield* Clock.currentTimeMillis;
      if (ended - now >= L.healthyRunMs) resyncs = 0;
      if (result.failure instanceof OrganizationLimit) {
        input.status("paused", result.failure.reason);
        yield* Effect.logWarning(
          `Automatic thread organisation stopped: ${result.failure.message}. It retries after a settings change.`,
        );
        yield* input.explicitRetry ?? input.retry ?? Effect.never;
        failures = [];
        resyncs = 0;
        continue;
      }
      if (result.failure instanceof OrganizationResync) {
        resyncs += 1;
        yield* Effect.sleep(Math.min(L.resyncMaxMs, L.resyncMinMs * 2 ** Math.min(resyncs - 1, 8)));
        continue;
      }
      failures.push(ended);
      input.status("paused");
      yield* Effect.logWarning(
        "Automatic thread organisation is paused; native resynchronisation will be attempted.",
      );
      yield* Effect.sleep(200 * 2 ** (failures.length - 1));
    }
  });
}
