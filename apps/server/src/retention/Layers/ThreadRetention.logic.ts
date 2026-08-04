import {
  THREAD_RETENTION_POLICY_DURATIONS_MS,
  type FiniteThreadRetentionPolicy,
} from "@bigbud/contracts/core/settings.threadRetention.ts";

import type { ThreadRetentionRun } from "../../persistence/Services/ThreadRetentionRepository.ts";

export const cutoffForRetentionPolicy = (
  policy: FiniteThreadRetentionPolicy,
  generatedAtMs: number,
) => new Date(generatedAtMs - THREAD_RETENTION_POLICY_DURATIONS_MS[policy]).toISOString();

export const toPublicThreadRetentionRun = (run: ThreadRetentionRun) => ({
  runId: run.runId,
  trigger: run.trigger,
  policy: run.policy,
  cutoffAt: run.cutoffAt,
  status: run.status,
  eligibleCount: run.eligibleCount,
  selectedCount: run.selectedCount,
  requestedCount: run.requestedCount,
  completedCount: run.completedCount,
  skippedCount: run.skippedCount,
  failedCount: run.failedCount,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  completedAt: run.completedAt,
  deferredReason: run.status === "deferred" ? run.lastErrorCode : null,
  errorMessage: run.status === "failed" ? "Thread retention maintenance failed." : null,
});
