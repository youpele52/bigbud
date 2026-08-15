import { Cause, Effect, Fiber, Queue, Ref, Schedule, Scope, Semaphore } from "effect";

import { runThreadRetentionSchedule } from "./ThreadRetention.scheduler.ts";
import { normalThreadRetentionWork, type ThreadRetentionWork } from "./ThreadRetention.worker.ts";

export const makeThreadRetentionWakeScheduler = Effect.fn("ThreadRetention.makeWakeScheduler")(
  function* (input: {
    readonly workQueue: Queue.Queue<ThreadRetentionWork>;
    readonly scope: Scope.Scope;
    readonly now?: () => number;
  }) {
    const now = input.now ?? Date.now;
    const semaphore = yield* Semaphore.make(1);
    const sleepers = new Map<
      string,
      { readonly wakeAt: string; readonly token: symbol; readonly fiber: Fiber.Fiber<void, never> }
    >();
    const scheduleWake = (
      runId: string,
      wakeAt: string,
      work: ThreadRetentionWork = normalThreadRetentionWork,
    ) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const existing = sleepers.get(runId);
          if (existing?.wakeAt === wakeAt) return;
          if (existing) yield* Fiber.interrupt(existing.fiber);
          const token = Symbol(runId);
          const fiber = yield* Effect.sleep(Math.max(0, Date.parse(wakeAt) - now())).pipe(
            Effect.andThen(Queue.offer(input.workQueue, work)),
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
    const cancelWake = (runId: string) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const existing = sleepers.get(runId);
          if (!existing) return;
          sleepers.delete(runId);
          yield* Fiber.interrupt(existing.fiber);
        }),
      );
    return { scheduleWake, cancelWake };
  },
);

export function makeThreadRetentionRunWakeScheduler(input: {
  readonly freshManualRunIds: Ref.Ref<ReadonlyArray<string>>;
  readonly scheduleWake: (
    runId: string,
    wakeAt: string,
    work?: ThreadRetentionWork,
  ) => Effect.Effect<void>;
}) {
  return (runId: string, wakeAt: string) =>
    Ref.get(input.freshManualRunIds).pipe(
      Effect.flatMap((runIds) =>
        input.scheduleWake(
          runId,
          wakeAt,
          runIds.includes(runId) ? { _tag: "freshManual", runId } : normalThreadRetentionWork,
        ),
      ),
    );
}

export function makeThreadRetentionStart<E>(input: {
  readonly maintenanceReadyAt: Ref.Ref<number | null>;
  readonly readyDelayMs: number;
  readonly workQueue: Queue.Queue<ThreadRetentionWork>;
  readonly runScheduledTick: Effect.Effect<void, E>;
}) {
  return Ref.set(input.maintenanceReadyAt, Date.now() + input.readyDelayMs).pipe(
    Effect.andThen(
      Effect.all(
        [
          Effect.sleep(input.readyDelayMs).pipe(
            Effect.andThen(
              Effect.repeat(
                Queue.offer(input.workQueue, normalThreadRetentionWork).pipe(
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
