import { Cause, Effect, Fiber, Queue, Ref, Schedule, Scope, Semaphore } from "effect";

import type { ThreadRetentionRepositoryShape } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { runThreadRetentionSchedule } from "./ThreadRetention.scheduler.ts";

export const makeThreadRetentionWakeScheduler = Effect.fn("ThreadRetention.makeWakeScheduler")(
  function* (input: {
    readonly workQueue: Queue.Queue<string>;
    readonly scope: Scope.Scope;
    readonly now?: () => number;
  }) {
    const now = input.now ?? Date.now;
    const semaphore = yield* Semaphore.make(1);
    const sleepers = new Map<
      string,
      { readonly wakeAt: string; readonly token: symbol; readonly fiber: Fiber.Fiber<void, never> }
    >();
    return (runId: string, wakeAt: string) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const existing = sleepers.get(runId);
          if (existing?.wakeAt === wakeAt) return;
          if (existing) yield* Fiber.interrupt(existing.fiber);
          const token = Symbol(runId);
          const fiber = yield* Effect.sleep(Math.max(0, Date.parse(wakeAt) - now())).pipe(
            Effect.andThen(Queue.offer(input.workQueue, runId)),
            Effect.asVoid,
            Effect.ensuring(
              Effect.sync(() => {
                if (sleepers.get(runId)?.token === token) sleepers.delete(runId);
              }),
            ),
            Effect.forkIn(input.scope),
          );
          sleepers.set(runId, { wakeAt, token, fiber });
        }),
      );
  },
);

export function makeThreadRetentionStart<E>(input: {
  readonly maintenanceReadyAt: Ref.Ref<number | null>;
  readonly readyDelayMs: number;
  readonly repository: ThreadRetentionRepositoryShape;
  readonly workQueue: Queue.Queue<string>;
  readonly runScheduledTick: Effect.Effect<void, E>;
  readonly scheduleWake: (runId: string, wakeAt: string) => Effect.Effect<void>;
}) {
  return Ref.set(input.maintenanceReadyAt, Date.now() + input.readyDelayMs).pipe(
    Effect.andThen(
      Effect.all(
        [
          Effect.sleep(input.readyDelayMs).pipe(
            Effect.andThen(
              Effect.repeat(
                input.repository.listRecoverableRuns(1).pipe(
                  Effect.flatMap((runs) =>
                    Effect.forEach(
                      runs,
                      (run) =>
                        run.nextAttemptAt !== null && run.nextAttemptAt > new Date().toISOString()
                          ? input.scheduleWake(run.runId, run.nextAttemptAt)
                          : Queue.offer(input.workQueue, run.runId),
                      { discard: true },
                    ),
                  ),
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.failCause(cause)
                      : Effect.logWarning("thread retention wake poll failed", {
                          reason: "wake_poll_failure",
                        }),
                  ),
                ),
                Schedule.fixed("1 minute"),
              ),
            ),
          ),
          runThreadRetentionSchedule(input.runScheduledTick),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    ),
    Effect.catchCause(() =>
      Effect.logWarning("thread retention scheduler stopped", {
        reason: "scheduler_failure",
      }),
    ),
  );
}
