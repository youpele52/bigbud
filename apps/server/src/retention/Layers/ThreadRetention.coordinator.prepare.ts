import { Effect, Option } from "effect";

import type { EntityPurgeShape } from "../../deletion/Services/EntityPurge.ts";
import { increment, threadRetentionItemsTotal } from "../../observability/Metrics.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";
import type { PurgeJobRepositoryShape } from "../../persistence/Services/PurgeJobRepository.ts";
import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import {
  persistRequiredBaselineSequence,
  RETENTION_PREPARATION_TIMEOUT_MS,
  retentionRetryDelayMs,
  retentionFinalizeCommandId,
  runRetentionEffectWithinDeadline,
} from "./ThreadRetention.coordinator.helpers.ts";
import type { RetentionRuntimeCleanupResult } from "./ThreadRetention.cleanup.ts";

export function makeReconcileRequestedRetentionItem(input: {
  readonly repository: ThreadRetentionRepositoryShape;
  readonly purgeJobs: PurgeJobRepositoryShape;
  readonly receipts: OrchestrationCommandReceiptRepositoryShape;
  readonly threads: ProjectionThreadRepositoryShape;
  readonly entityPurge: EntityPurgeShape;
  readonly orchestration: OrchestrationEngineShape;
  readonly retryRuntimeCleanup: (
    threadId: ThreadRetentionRunItem["threadId"],
  ) => Effect.Effect<RetentionRuntimeCleanupResult>;
  readonly now: () => number;
}) {
  return Effect.fn("ThreadRetention.reconcileRequested")(function* (
    run: ThreadRetentionRun,
    item: ThreadRetentionRunItem,
    deadlineAt: number,
  ) {
    const prepare = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      runRetentionEffectWithinDeadline({
        effect,
        deadlineAt,
        now: input.now,
        maxDurationMs: RETENTION_PREPARATION_TIMEOUT_MS,
      });
    const cleanupResult = yield* prepare(input.retryRuntimeCleanup(item.threadId));
    if (Option.isNone(cleanupResult)) return "timeout" as const;
    const cleanup = cleanupResult.value;
    if (cleanup === "active" || cleanup === "failed") {
      const failedAt = input.now();
      yield* input.repository.recordItemRetry({
        runId: run.runId,
        threadId: item.threadId,
        expectedStatuses: ["deletion_requested"],
        lastErrorCode: "cleanup_failed",
        nextAttemptAt: new Date(
          failedAt + retentionRetryDelayMs(item.attemptCount + 1),
        ).toISOString(),
        updatedAt: new Date(failedAt).toISOString(),
      });
      return "complete" as const;
    }
    const incomplete = yield* input.purgeJobs.findIncomplete({
      entityKind: "thread",
      entityId: item.threadId,
    });
    const markPrepared = (purgeJobId: string) =>
      input.repository
        .markPrepared({
          runId: run.runId,
          threadId: item.threadId,
          purgeJobId,
          updatedAt: new Date(input.now()).toISOString(),
        })
        .pipe(
          Effect.tap((prepared) =>
            prepared ? increment(threadRetentionItemsTotal, { outcome: "prepared" }) : Effect.void,
          ),
        );
    const persistFinalized = (sequence: number) =>
      persistRequiredBaselineSequence(
        input.repository,
        run.runId,
        sequence,
        new Date(input.now()).toISOString(),
      );
    const finalizeReceipt = yield* input.receipts.getByCommandId({
      commandId: retentionFinalizeCommandId(run.runId, item.threadId),
    });
    if (Option.isSome(finalizeReceipt) && finalizeReceipt.value.status === "accepted") {
      const jobResult = Option.isSome(incomplete)
        ? Option.some(incomplete.value)
        : yield* prepare(input.entityPurge.requestThread(item.threadId));
      if (Option.isNone(jobResult)) return "timeout" as const;
      yield* persistFinalized(finalizeReceipt.value.resultSequence);
      yield* markPrepared(jobResult.value.jobId);
      return "complete" as const;
    }

    const thread = yield* input.threads.getById({ threadId: item.threadId });
    if (Option.isSome(thread) && thread.value.deletedAt !== null) {
      const jobResult = Option.isSome(incomplete)
        ? Option.some(incomplete.value)
        : yield* prepare(input.entityPurge.requestThread(item.threadId));
      if (Option.isNone(jobResult)) return "timeout" as const;
      yield* markPrepared(jobResult.value.jobId);
      return "complete" as const;
    }
    if (Option.isSome(thread) && thread.value.deletingAt === null) return;

    const jobResult = Option.isSome(incomplete)
      ? Option.some(incomplete.value)
      : yield* prepare(input.entityPurge.requestThread(item.threadId));
    if (Option.isNone(jobResult)) return "timeout" as const;
    const finalizedResult = yield* prepare(
      input.orchestration.dispatch({
        type: "thread.delete.finalize",
        commandId: retentionFinalizeCommandId(run.runId, item.threadId),
        threadId: item.threadId,
        createdAt: new Date(input.now()).toISOString(),
      }),
    );
    if (Option.isNone(finalizedResult)) return "timeout" as const;
    yield* persistFinalized(finalizedResult.value.sequence);
    yield* markPrepared(jobResult.value.jobId);
    return "complete" as const;
  });
}
