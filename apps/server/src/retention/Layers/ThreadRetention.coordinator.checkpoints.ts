import { Effect, Option } from "effect";

import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
} from "../../persistence/Services/ThreadRetentionRepository.ts";

export function makeRetentionCheckpointTransitions(input: {
  readonly repository: ThreadRetentionRepositoryShape;
  readonly scheduleWake: (runId: string, wakeAt: string) => Effect.Effect<void>;
  readonly now: () => number;
}) {
  const continueRun = Effect.fn("ThreadRetention.continueRun")(function* (run: ThreadRetentionRun) {
    const continueAt = new Date(input.now()).toISOString();
    const moved = yield* input.repository.transitionRun({
      runId: run.runId,
      expectedStatuses: [run.status],
      nextStatus: "deferred",
      updatedAt: continueAt,
      nextAttemptAt: continueAt,
      lastErrorCode: "page_continue",
    });
    if (moved) yield* input.scheduleWake(run.runId, continueAt);
  });

  const pauseForItemRetry = Effect.fn("ThreadRetention.pauseForItemRetry")(function* (
    run: ThreadRetentionRun,
    nextAttemptAt: string,
  ) {
    const failedAt = new Date(input.now()).toISOString();
    const retry = yield* input.repository.recordRunFailure({
      runId: run.runId,
      expectedStatuses: [run.status],
      failedAt,
      lastErrorCode: "item_retry",
      isolateItemFailure: true,
    });
    const wakeAt =
      Option.isSome(retry) &&
      retry.value.nextAttemptAt !== null &&
      retry.value.nextAttemptAt > nextAttemptAt
        ? retry.value.nextAttemptAt
        : nextAttemptAt;
    const moved = yield* input.repository.transitionRun({
      runId: run.runId,
      expectedStatuses: [run.status],
      nextStatus: "deferred",
      updatedAt: failedAt,
      nextAttemptAt: wakeAt,
      lastErrorCode: "item_retry",
      releaseActiveSlot: true,
    });
    if (moved) yield* input.scheduleWake(run.runId, wakeAt);
  });

  return { continueRun, pauseForItemRetry };
}
