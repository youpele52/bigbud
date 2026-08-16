import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";

import type { EntityPurgeShape } from "../../deletion/Services/EntityPurge.ts";
import {
  increment,
  threadRetentionGroupDuration,
  threadRetentionGroupSize,
  threadRetentionItemsTotal,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  PURGE_MAX_ATTEMPTS,
  type PurgeJobRepositoryShape,
} from "../../persistence/Services/PurgeJobRepository.ts";
import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { runRetentionEffectWithinDeadline } from "./ThreadRetention.coordinator.helpers.ts";

export function makePurgePreparedRetentionItems(input: {
  readonly repository: ThreadRetentionRepositoryShape;
  readonly purgeJobs: PurgeJobRepositoryShape;
  readonly entityPurge: EntityPurgeShape;
}) {
  return Effect.fn("ThreadRetention.purgePrepared")(function* (
    run: ThreadRetentionRun,
    items: ReadonlyArray<ThreadRetentionRunItem>,
    deadlineAt = Number.POSITIVE_INFINITY,
    now: () => number = Date.now,
  ) {
    const jobs = [];
    const markPurgeFailure = (item: ThreadRetentionRunItem, errorCode: string) =>
      input.repository
        .transitionItem({
          runId: run.runId,
          threadId: item.threadId,
          expectedStatuses: [item.status],
          nextStatus: "failed",
          lastErrorCode: errorCode,
          updatedAt: new Date(now()).toISOString(),
        })
        .pipe(
          Effect.tap((failed) =>
            failed ? increment(threadRetentionItemsTotal, { outcome: "failed" }) : Effect.void,
          ),
        );
    const persistPurgeRetry = (item: ThreadRetentionRunItem, nextAttemptAt: string) =>
      item.nextAttemptAt === nextAttemptAt
        ? Effect.void
        : input.repository.recordItemRetry({
            runId: run.runId,
            threadId: item.threadId,
            expectedStatuses: ["prepared", "purging"],
            lastErrorCode: "purge_failed",
            nextAttemptAt,
            updatedAt: new Date(now()).toISOString(),
          });
    const recoveryFirst = items
      .filter((candidate) => ["prepared", "purging"].includes(candidate.status))
      .toSorted(
        (left, right) => Number(right.status === "purging") - Number(left.status === "purging"),
      );
    for (const item of recoveryFirst) {
      if (now() >= deadlineAt) return "timeout" as const;
      const incomplete = yield* input.purgeJobs.findIncomplete({
        entityKind: "thread",
        entityId: item.threadId,
      });
      if (Option.isNone(incomplete)) {
        if (item.purgeJobId === null) return "pending" as const;
        const persisted = yield* input.purgeJobs.findById(item.purgeJobId);
        if (Option.isNone(persisted)) return "pending" as const;
        if (persisted.value.lastError === "manual_recovery_required") {
          yield* input.repository.transitionItem({
            runId: run.runId,
            threadId: item.threadId,
            expectedStatuses: [item.status],
            nextStatus: "failed",
            lastErrorCode: "manual_recovery_required",
            updatedAt: new Date().toISOString(),
          });
          yield* increment(threadRetentionItemsTotal, { outcome: "failed" });
          continue;
        }
        if (persisted.value.status !== "completed") return "pending" as const;
        if (item.status === "prepared") {
          yield* input.repository.transitionItem({
            runId: run.runId,
            threadId: item.threadId,
            expectedStatuses: ["prepared"],
            nextStatus: "purging",
            updatedAt: new Date().toISOString(),
          });
        }
        yield* input.repository.transitionItem({
          runId: run.runId,
          threadId: item.threadId,
          expectedStatuses: ["purging"],
          nextStatus: "completed",
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      if (incomplete.value.lastError === "manual_recovery_required") {
        yield* input.repository.transitionItem({
          runId: run.runId,
          threadId: item.threadId,
          expectedStatuses: [item.status],
          nextStatus: "failed",
          lastErrorCode: "manual_recovery_required",
          updatedAt: new Date().toISOString(),
        });
        yield* increment(threadRetentionItemsTotal, { outcome: "failed" });
        continue;
      }
      if (
        incomplete.value.status === "failed" &&
        incomplete.value.attemptCount >= PURGE_MAX_ATTEMPTS
      ) {
        yield* input.repository.transitionItem({
          runId: run.runId,
          threadId: item.threadId,
          expectedStatuses: [item.status],
          nextStatus: "failed",
          lastErrorCode: "purge_retry_exhausted",
          updatedAt: new Date().toISOString(),
        });
        yield* increment(threadRetentionItemsTotal, { outcome: "failed" });
        continue;
      }
      if (
        incomplete.value.status === "failed" &&
        incomplete.value.updatedAt > new Date(now()).toISOString()
      ) {
        yield* persistPurgeRetry(item, incomplete.value.updatedAt);
        continue;
      }
      if (item.status === "prepared") {
        if (now() >= deadlineAt) return "timeout" as const;
        yield* input.repository.transitionItem({
          runId: run.runId,
          threadId: item.threadId,
          expectedStatuses: ["prepared"],
          nextStatus: "purging",
          updatedAt: new Date().toISOString(),
        });
      }
      jobs.push(incomplete.value);
    }
    if (jobs.length === 0) return "complete" as const;
    jobs.sort(
      (left, right) => Number(right.status === "failed") - Number(left.status === "failed"),
    );
    if (now() >= deadlineAt) return "timeout" as const;
    yield* increment(threadRetentionGroupSize, { phase: "purge" }, jobs.length);
    const purgeResult = yield* runRetentionEffectWithinDeadline({
      effect: Effect.exit(
        input.entityPurge.runBatch(jobs).pipe(
          withMetrics({
            timer: threadRetentionGroupDuration,
            attributes: { phase: "purge" },
          }),
        ),
      ),
      deadlineAt,
      now,
    });
    if (Option.isNone(purgeResult)) return "timeout" as const;
    if (purgeResult.value._tag === "Failure") return "pending" as const;

    let complete = true;
    for (const job of jobs) {
      if (now() >= deadlineAt) return "timeout" as const;
      const incomplete = yield* input.purgeJobs.findIncomplete({
        entityKind: "thread",
        entityId: job.entityId,
      });
      if (Option.isSome(incomplete)) {
        const item = items.find((candidate) => candidate.threadId === job.entityId);
        if (incomplete.value.lastError === "manual_recovery_required") {
          if (item) yield* markPurgeFailure(item, "manual_recovery_required");
          continue;
        }
        if (
          incomplete.value.status === "failed" &&
          incomplete.value.attemptCount >= PURGE_MAX_ATTEMPTS
        ) {
          if (item) yield* markPurgeFailure(item, "purge_retry_exhausted");
          continue;
        }
        if (
          incomplete.value.status === "failed" &&
          incomplete.value.updatedAt > new Date(now()).toISOString()
        ) {
          if (item) yield* persistPurgeRetry(item, incomplete.value.updatedAt);
          continue;
        }
        complete = false;
        continue;
      }
      const persisted = yield* input.purgeJobs.findById(job.jobId);
      if (Option.isNone(persisted) || persisted.value.status !== "completed") {
        complete = false;
        continue;
      }
      yield* input.repository.transitionItem({
        runId: run.runId,
        threadId: ThreadId.makeUnsafe(job.entityId),
        expectedStatuses: ["purging"],
        nextStatus: "completed",
        updatedAt: new Date().toISOString(),
      });
      yield* increment(threadRetentionItemsTotal, { outcome: "completed" });
    }
    return complete ? ("complete" as const) : ("pending" as const);
  });
}
