/**
 * Ìtútù snooze delivery. Each pending snooze gets a timer keyed by thread, replaced or cleared
 * by every organization change. A sweep at start and every 30 s delivers snoozes whose timer was
 * lost (restart, sleep, clock change). Delivery only dispatches the expire command; the decider
 * applies it once, and only while that snooze is still the thread's current one.
 *
 * @module ThreadOrganizationReactor.snooze
 */
import type { ThreadId } from "@bigbud/contracts";
import { Clock, Effect, FiberMap, Schedule, Stream } from "effect";

import type {
  PendingThreadSnooze,
  ProjectionThreadRepositoryShape,
} from "../../persistence/Services/ProjectionThreads.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  expireSnoozeCommand,
  isSnoozeDue,
  SNOOZE_EXPIRE_ATTEMPTS,
  SNOOZE_SWEEP_BATCH,
  SNOOZE_SWEEP_INTERVAL_MS,
  snoozeDelayMs,
  snoozeEventEffect,
} from "./ThreadOrganizationReactor.snooze.logic.ts";

export const startThreadSnoozeDelivery = Effect.fn("startThreadSnoozeDelivery")(function* (input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch" | "streamDomainEvents">;
  readonly threadRepository: Pick<ProjectionThreadRepositoryShape, "listPendingSnoozes">;
}) {
  const timers = yield* FiberMap.make<ThreadId>();

  const expire = (snooze: PendingThreadSnooze) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const command = expireSnoozeCommand(snooze, new Date(nowMs).toISOString());
      yield* input.orchestrationEngine.dispatch(command).pipe(
        Effect.retry({
          times: SNOOZE_EXPIRE_ATTEMPTS,
          schedule: Schedule.exponential("200 millis"),
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("snooze delivery failed; the sweep retries it", {
          threadId: snooze.threadId,
          snoozeId: snooze.snoozeId,
          cause: cause.toString(),
        }),
      ),
    );

  // Timers may fire marginally early; wait until the deadline really passed.
  const waitForDeadline = (until: string): Effect.Effect<void> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) =>
        isSnoozeDue(until, nowMs)
          ? Effect.void
          : Effect.sleep(snoozeDelayMs(until, nowMs)).pipe(Effect.andThen(waitForDeadline(until))),
      ),
    );

  const schedule = (snooze: PendingThreadSnooze, options?: { readonly onlyIfMissing: boolean }) =>
    FiberMap.run(
      timers,
      snooze.threadId,
      waitForDeadline(snooze.until).pipe(Effect.andThen(expire(snooze))),
      options,
    );

  // Pages with a keyset cursor, so rows that keep failing never starve later snoozes.
  const sweep = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    let after: { readonly until: string; readonly threadId: ThreadId } | undefined;
    for (;;) {
      const rows = yield* input.threadRepository.listPendingSnoozes({
        limit: SNOOZE_SWEEP_BATCH,
        ...(after !== undefined ? { after } : {}),
      });
      for (const row of rows) {
        if (!isSnoozeDue(row.until, nowMs)) {
          yield* schedule(row, { onlyIfMissing: true });
          continue;
        }
        // A due snooze whose timer lags (system sleep) is delivered here, exactly once.
        yield* FiberMap.remove(timers, row.threadId);
        yield* expire(row);
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < SNOOZE_SWEEP_BATCH) break;
      after = { until: last.until, threadId: last.threadId };
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("snooze sweep failed", { cause: cause.toString() }),
    ),
  );

  yield* Effect.forkScoped(
    Stream.runForEach(input.orchestrationEngine.streamDomainEvents, (event) => {
      const effect = snoozeEventEffect(event);
      if (effect === null) return Effect.void;
      return effect.type === "schedule"
        ? schedule(effect.snooze)
        : FiberMap.remove(timers, effect.threadId);
    }),
  );
  yield* Effect.forkScoped(
    sweep.pipe(Effect.repeat(Schedule.spaced(`${SNOOZE_SWEEP_INTERVAL_MS} millis`))),
  );
});
