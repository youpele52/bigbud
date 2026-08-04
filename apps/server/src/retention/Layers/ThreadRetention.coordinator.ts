import type { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention.ts";
import { Effect, Option } from "effect";

import type { EntityPurgeShape } from "../../deletion/Services/EntityPurge.ts";
import {
  increment,
  threadRetentionDeferralMetricAttributes,
  threadRetentionDeferralsTotal,
  threadRetentionItemsTotal,
  threadRetentionRunsTotal,
  threadRetentionSelectionDuration,
  withMetrics,
} from "../../observability/Metrics.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import type { ProjectionThreadRepositoryShape } from "../../persistence/Services/ProjectionThreads.ts";
import type { PurgeJobRepositoryShape } from "../../persistence/Services/PurgeJobRepository.ts";
import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import {
  countOutstandingRetentionItems,
  RETENTION_BACKLOG_LIMIT,
  RETENTION_PAGE_SIZE,
  RETENTION_SLICE_BUDGET_MS,
  retentionRetryDelayMs,
  successfulRetentionStatus,
  type ThreadRetentionRepositoryAuditExtensions,
} from "./ThreadRetention.coordinator.helpers.ts";
import { makeDispatchSelectedRetentionItems } from "./ThreadRetention.coordinator.dispatch.ts";
import { makePurgePreparedRetentionItems } from "./ThreadRetention.coordinator.purge.ts";
import { makeReconcileRequestedRetentionItem } from "./ThreadRetention.coordinator.prepare.ts";
import type { RetentionRuntimeCleanupResult } from "./ThreadRetention.cleanup.ts";

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "completed_with_failures",
  "failed",
  "cancelled",
]);

export function makeProcessThreadRetentionRun(input: {
  readonly repository: ThreadRetentionRepositoryShape;
  readonly purgeJobs: PurgeJobRepositoryShape;
  readonly receipts: OrchestrationCommandReceiptRepositoryShape;
  readonly threads: ProjectionThreadRepositoryShape;
  readonly entityPurge: EntityPurgeShape;
  readonly orchestration: OrchestrationEngineShape;
  readonly retryRuntimeCleanup: (
    threadId: ThreadRetentionRunItem["threadId"],
  ) => Effect.Effect<RetentionRuntimeCleanupResult>;
  readonly selectionGate: (
    run: ThreadRetentionRun,
  ) => Effect.Effect<
    | "disabled"
    | "policy_never"
    | "policy_changed"
    | "provider_pressure"
    | { readonly reason: "recent_failures"; readonly wakeAt: string }
    | null
  >;
  readonly scheduleWake: (runId: string, wakeAt: string) => Effect.Effect<void>;
  readonly loadRun: (
    runId: string,
  ) => Effect.Effect<ThreadRetentionRun, ServerThreadRetentionError | ProjectionRepositoryError>;
  readonly now?: () => number;
}) {
  const repository = input.repository as ThreadRetentionRepositoryAuditExtensions;
  const now = input.now ?? Date.now;
  const purgePrepared = makePurgePreparedRetentionItems(input);
  const reconcileRequested = makeReconcileRequestedRetentionItem({ ...input, now });
  const dispatchSelected = makeDispatchSelectedRetentionItems({ ...input, now });
  const deferRun = Effect.fn("ThreadRetention.deferRun")(function* (
    run: ThreadRetentionRun,
    reason: string,
    requestedWakeAt?: string,
  ) {
    const items = yield* input.repository.listOutstandingItems(run.runId, RETENTION_BACKLOG_LIMIT);
    const attempt = Math.max(1, ...items.map((item) => item.attemptCount));
    const deferredAt = new Date(now()).toISOString();
    const retryAt = new Date(now() + retentionRetryDelayMs(attempt)).toISOString();
    let nextAttemptAt = requestedWakeAt && requestedWakeAt > retryAt ? requestedWakeAt : retryAt;
    const cleanupFailed = items.some(
      (item) => item.status === "deletion_requested" && item.lastErrorCode === "cleanup_failed",
    );
    if (reason === "purge_deferred" || (reason === "preparation_pending" && cleanupFailed)) {
      const retryState = yield* input.repository.recordRunFailure({
        runId: run.runId,
        expectedStatuses: [run.status],
        failedAt: deferredAt,
        lastErrorCode: reason,
      });
      if (Option.isSome(retryState) && retryState.value.nextAttemptAt !== null) {
        nextAttemptAt = retryState.value.nextAttemptAt;
      }
    }
    const moved = yield* input.repository.transitionRun({
      runId: run.runId,
      expectedStatuses: [run.status],
      nextStatus: "deferred",
      updatedAt: deferredAt,
      nextAttemptAt,
      lastErrorCode: reason,
    });
    if (moved) {
      yield* increment(threadRetentionDeferralsTotal, {
        ...threadRetentionDeferralMetricAttributes(reason),
        trigger: run.trigger,
        policy: run.policy,
      });
      yield* input.scheduleWake(run.runId, nextAttemptAt);
    }
  });

  const finishRun = Effect.fn("ThreadRetention.finishRun")(function* (
    run: ThreadRetentionRun,
    status: "completed" | "completed_with_failures",
  ) {
    if (status === "completed_with_failures") {
      yield* input.repository.recordRunFailure({
        runId: run.runId,
        expectedStatuses: [run.status],
        failedAt: new Date(now()).toISOString(),
        lastErrorCode: "item_failures",
      });
    }
    const moved = yield* input.repository.transitionRun({
      runId: run.runId,
      expectedStatuses: [run.status],
      nextStatus: status,
      updatedAt: new Date().toISOString(),
      nextAttemptAt: null,
      lastErrorCode: null,
    });
    if (moved)
      yield* increment(threadRetentionRunsTotal, {
        trigger: run.trigger,
        policy: run.policy,
        outcome: status,
      });
  });

  return Effect.fn("ThreadRetention.processRun")(function* (runId: string) {
    const sliceStartedAt = now();
    const deadlineAt = sliceStartedAt + RETENTION_SLICE_BUDGET_MS;
    let run = yield* input.loadRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    if (run.nextAttemptAt !== null && run.nextAttemptAt > new Date().toISOString()) {
      yield* input.scheduleWake(runId, run.nextAttemptAt);
      return;
    }

    if (run.status === "queued" || run.status === "deferred") {
      const items = yield* input.repository.listOutstandingItems(runId, RETENTION_BACKLOG_LIMIT);
      const hasPurgeWork = items.some((item) => ["prepared", "purging"].includes(item.status));
      const hasPreparationWork = items.some((item) =>
        ["selected", "deletion_requested"].includes(item.status),
      );
      const nextStatus = hasPurgeWork ? "purging" : hasPreparationWork ? "preparing" : "selecting";
      yield* input.repository.transitionRun({
        runId,
        expectedStatuses: [run.status],
        nextStatus,
        updatedAt: new Date().toISOString(),
        nextAttemptAt: null,
        lastErrorCode: null,
      });
      run = yield* input.loadRun(runId);
    }

    if (run.status === "selecting") {
      const items = yield* input.repository.listOutstandingItems(runId, RETENTION_BACKLOG_LIMIT);
      if (
        items.some((item) =>
          ["selected", "deletion_requested", "prepared", "purging"].includes(item.status),
        )
      ) {
        yield* input.repository.transitionRun({
          runId,
          expectedStatuses: ["selecting"],
          nextStatus: "preparing",
          updatedAt: new Date().toISOString(),
        });
        run = yield* input.loadRun(runId);
      }
    }

    if (run.status === "selecting") {
      const gate = yield* input.selectionGate(run);
      if (gate !== null) {
        if (gate === "policy_never" || gate === "policy_changed")
          yield* finishRun(run, "completed");
        else if (typeof gate === "string") yield* deferRun(run, gate);
        else yield* deferRun(run, gate.reason, gate.wakeAt);
        return;
      }
      if (now() - sliceStartedAt >= RETENTION_SLICE_BUDGET_MS) {
        yield* deferRun(run, "slice_budget");
        return;
      }
      const outstandingCount = yield* countOutstandingRetentionItems(repository, runId);
      if (outstandingCount >= RETENTION_BACKLOG_LIMIT) {
        yield* deferRun(run, "backlog_limit");
        return;
      }
      const cursor =
        run.cursorLastActivityAt !== null && run.cursorThreadId !== null
          ? { lastActivityAt: run.cursorLastActivityAt, threadId: run.cursorThreadId }
          : undefined;
      const candidates = yield* input.repository
        .selectNextPage({
          cutoffAt: run.cutoffAt,
          ...(cursor ? { cursor } : {}),
          limit: Math.min(RETENTION_PAGE_SIZE, RETENTION_BACKLOG_LIMIT - outstandingCount),
        })
        .pipe(withMetrics({ timer: threadRetentionSelectionDuration }));
      if (now() - sliceStartedAt >= RETENTION_SLICE_BUDGET_MS) {
        yield* deferRun(run, "slice_budget");
        return;
      }
      if (candidates.length === 0) {
        yield* finishRun(run, successfulRetentionStatus(run));
        return;
      }
      const last = candidates.at(-1)!;
      const inserted = yield* input.repository.insertSelectedPage({
        runId,
        candidates: candidates.map((candidate) => ({
          threadId: candidate.threadId,
          lastActivityAt: candidate.lastActivityAt,
          deletionCommandId: `server:thread-retention:${runId}:${candidate.threadId}`,
        })),
        createdAt: new Date().toISOString(),
        expectedStatus: "selecting",
        expectedCursor: cursor ?? null,
        nextCursor: last,
      });
      if (!inserted.applied) return;
      yield* increment(threadRetentionItemsTotal, { outcome: "selected" }, inserted.insertedCount);
      yield* input.repository.transitionRun({
        runId,
        expectedStatuses: ["selecting"],
        nextStatus: "preparing",
        updatedAt: new Date().toISOString(),
      });
      run = yield* input.loadRun(runId);
    }

    if (run.status === "preparing") {
      let items = yield* input.repository.listOutstandingItems(runId, RETENTION_BACKLOG_LIMIT);
      if (now() >= deadlineAt) {
        yield* deferRun(run, "slice_budget");
        return;
      }
      const dispatchGate = yield* dispatchSelected(run, items, deadlineAt);
      if (dispatchGate !== null) {
        if (typeof dispatchGate === "string") yield* deferRun(run, dispatchGate);
        else yield* deferRun(run, dispatchGate.reason, dispatchGate.wakeAt);
        return;
      }
      items = yield* input.repository.listOutstandingItems(runId, RETENTION_BACKLOG_LIMIT);
      for (const item of items.filter((candidate) => candidate.status === "deletion_requested")) {
        if (now() >= deadlineAt) break;
        const reconciled = yield* reconcileRequested(run, item, deadlineAt);
        if (reconciled === "timeout") break;
      }
      items = yield* input.repository.listOutstandingItems(runId, RETENTION_BACKLOG_LIMIT);
      run = yield* input.loadRun(runId);
      if (now() >= deadlineAt && items.some((item) => item.status === "deletion_requested")) {
        yield* deferRun(run, "slice_budget");
        return;
      }
      if (items.some((item) => item.status === "deletion_requested")) {
        yield* deferRun(run, "preparation_pending");
        return;
      }
      if (items.some((item) => ["prepared", "purging"].includes(item.status))) {
        yield* input.repository.transitionRun({
          runId,
          expectedStatuses: ["preparing"],
          nextStatus: "purging",
          updatedAt: new Date().toISOString(),
          requiredBaselineSequence: run.requiredBaselineSequence,
        });
        run = yield* input.loadRun(runId);
      } else {
        const pageWasFull = run.selectedCount > 0 && run.selectedCount % RETENTION_PAGE_SIZE === 0;
        if (pageWasFull) {
          yield* deferRun(run, "page_budget");
          return;
        }
        yield* input.repository.transitionRun({
          runId,
          expectedStatuses: ["preparing"],
          nextStatus: "purging",
          updatedAt: new Date().toISOString(),
          requiredBaselineSequence: run.requiredBaselineSequence,
        });
        run = yield* input.loadRun(runId);
      }
    }

    if (run.status === "purging") {
      if (now() >= deadlineAt) {
        yield* deferRun(run, "slice_budget");
        return;
      }
      const purgeResult = yield* purgePrepared(
        run,
        yield* input.repository.listOutstandingItems(runId, RETENTION_BACKLOG_LIMIT),
        deadlineAt,
        now,
      );
      if (purgeResult === "timeout") {
        yield* deferRun(run, "slice_budget");
        return;
      }
      if (purgeResult === "pending") {
        yield* deferRun(run, "purge_deferred");
        return;
      }
      run = yield* input.loadRun(runId);
      const pageWasFull = run.selectedCount > 0 && run.selectedCount % RETENTION_PAGE_SIZE === 0;
      if (pageWasFull) yield* deferRun(run, "page_budget");
      else yield* finishRun(run, successfulRetentionStatus(run));
    }
  });
}
