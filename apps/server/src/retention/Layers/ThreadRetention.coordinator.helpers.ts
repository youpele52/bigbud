import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";

import type {
  RecentThreadRetentionFailureSummary,
  ThreadRetentionRepositoryShape,
  ThreadRetentionRun,
  ThreadRetentionRunItem,
} from "../../persistence/Services/ThreadRetentionRepository.ts";

export const RETENTION_PAGE_SIZE = 25;
export const RETENTION_BACKLOG_LIMIT = 250;
export const RETENTION_SLICE_BUDGET_MS = 30_000;
export const RETENTION_PREPARATION_TIMEOUT_MS = 5_000;
export const RETENTION_RETRY_BASE_MS = 15 * 60 * 1_000;
export const RETENTION_RETRY_CAP_MS = 24 * 60 * 60 * 1_000;

export type ThreadRetentionRepositoryAuditExtensions = ThreadRetentionRepositoryShape;

export function runRetentionEffectWithinDeadline<A, E, R>(input: {
  readonly effect: Effect.Effect<A, E, R>;
  readonly deadlineAt: number;
  readonly now: () => number;
  readonly maxDurationMs?: number;
}): Effect.Effect<Option.Option<A>, E, R> {
  const remainingMs = Math.max(0, input.deadlineAt - input.now());
  if (remainingMs === 0) return Effect.succeed(Option.none());
  return input.effect.pipe(
    Effect.timeoutOption(Math.min(remainingMs, input.maxDurationMs ?? remainingMs)),
  );
}

export const retentionFinalizeCommandId = (runId: string, threadId: string) =>
  CommandId.makeUnsafe(`server:thread-retention:finalize:${runId}:${threadId}`);

export const retentionAbortCommandId = (runId: string, threadId: string) =>
  CommandId.makeUnsafe(`server:thread-retention:abort:${runId}:${threadId}`);

export const hasProviderRuntimePressure = (states: ReadonlyArray<{ readonly status: string }>) =>
  states.some((state) => ["connecting", "starting", "running"].includes(state.status));

export const countOutstandingRetentionItems = Effect.fn("ThreadRetention.countOutstandingItems")(
  function* (repository: ThreadRetentionRepositoryAuditExtensions, runId: string) {
    return yield* repository.countOutstandingItems(runId);
  },
);

export const recentRetentionFailureSummary = Effect.fn("ThreadRetention.recentFailureSummary")(
  function* (repository: ThreadRetentionRepositoryAuditExtensions, nowMs: number) {
    return yield* repository.getRecentFailureSummary({
      since: new Date(nowMs - 60 * 60 * 1_000).toISOString(),
      limit: 3,
    });
  },
);

export const retentionCircuitReopenAt = (
  summary: RecentThreadRetentionFailureSummary | null,
): string | null => {
  if (!summary || summary.failureCount < 3 || summary.latestFailureAt === null) return null;
  return new Date(Date.parse(summary.latestFailureAt) + RETENTION_RETRY_CAP_MS).toISOString();
};

export const retentionRetryDelayMs = (attempt: number) =>
  Math.min(RETENTION_RETRY_CAP_MS, RETENTION_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));

export const retentionItemRetryIsDue = (item: ThreadRetentionRunItem, nowIso: string) =>
  item.nextAttemptAt === null || item.nextAttemptAt <= nowIso;

export const earliestRetentionItemRetry = (items: ReadonlyArray<ThreadRetentionRunItem>) =>
  items
    .flatMap((item) => (item.nextAttemptAt === null ? [] : [item.nextAttemptAt]))
    .toSorted()[0] ?? null;

export const persistRequiredBaselineSequence = Effect.fn(
  "ThreadRetention.persistRequiredBaselineSequence",
)(function* (
  repository: ThreadRetentionRepositoryShape,
  runId: string,
  sequence: number,
  updatedAt: string,
) {
  return yield* repository.recordRequiredBaselineSequence({ runId, sequence, updatedAt });
});

export const successfulRetentionStatus = (
  run: ThreadRetentionRun,
): "completed" | "completed_with_failures" =>
  run.failedCount > 0 ? "completed_with_failures" : "completed";
