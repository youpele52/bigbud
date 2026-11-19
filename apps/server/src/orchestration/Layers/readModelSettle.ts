/**
 * Waits for a read-model condition that later domain events are expected to satisfy.
 *
 * The wake-up stream is only a hint, never the guarantee:
 * - It is subscribed before the first check (the consumer fiber starts immediately, so a
 *   domain-event stream captures its replay cursor before the read model is checked). A commit
 *   that lands between the check and the subscription can no longer be skipped.
 * - The condition is also re-checked on a short bounded timer, so a wake-up that never arrives
 *   (pruned replay page, stream ended or died on a replay gap) delays the waiter by at most one
 *   interval instead of stranding it until the overall timeout.
 *
 * @module readModelSettle
 */
import type { OrchestrationEvent } from "@bigbud/contracts";
import { Cause, Duration, Effect, Option, Queue, Stream } from "effect";

export type ReadModelSettleCheck<A> =
  | { readonly done: true; readonly value: A }
  | { readonly done: false };

/** Upper bound on how long a satisfied condition can go unnoticed without a wake-up. */
export const READ_MODEL_SETTLE_RECHECK_INTERVAL = Duration.millis(500);

export const waitForReadModelCondition = Effect.fn("waitForReadModelCondition")(function* <
  A,
>(input: {
  readonly check: Effect.Effect<ReadModelSettleCheck<A>>;
  readonly events: Stream.Stream<OrchestrationEvent>;
  readonly timeout: Duration.Duration;
  readonly onTimeout: A;
  readonly recheckInterval?: Duration.Duration;
}) {
  const recheckInterval = input.recheckInterval ?? READ_MODEL_SETTLE_RECHECK_INTERVAL;
  const settled = Effect.scoped(
    Effect.gen(function* () {
      const wakeUps = yield* Queue.sliding<void>(1);
      yield* input.events.pipe(
        Stream.runForEach(() => Queue.offer(wakeUps, undefined)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logDebug("read model settle wake-up stream ended; re-checking on a timer", {
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      for (;;) {
        const result = yield* input.check;
        if (result.done) return result.value;
        yield* Queue.take(wakeUps).pipe(Effect.timeoutOption(recheckInterval));
      }
    }),
  );
  const outcome = yield* settled.pipe(Effect.timeoutOption(input.timeout));
  return Option.getOrElse(outcome, () => input.onTimeout);
});
