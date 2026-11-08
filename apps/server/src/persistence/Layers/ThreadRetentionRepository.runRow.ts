import type { ThreadRetentionRun } from "../Services/ThreadRetentionRepository.models.ts";
import { decodeRetentionExclusionSummary } from "./ThreadRetentionRepository.exclusions.ts";

/** Every `thread_retention_runs` column a run carries, shared by single and list reads. */
export const THREAD_RETENTION_RUN_COLUMNS = `
  run_id AS "runId", trigger_kind AS trigger, policy,
  selection_mode AS "selectionMode", age_criterion AS "ageCriterion",
  cutoff_at AS "cutoffAt", status,
  cursor_last_activity_at AS "cursorLastActivityAt", cursor_thread_id AS "cursorThreadId",
  eligible_count AS "eligibleCount", selected_count AS "selectedCount",
  skipped_count AS "skippedCount", requested_count AS "requestedCount",
  uncertain_count AS "uncertainCount",
  completed_count AS "completedCount", failed_count AS "failedCount",
  estimated_resource_count AS "estimatedResourceCount",
  required_baseline_sequence AS "requiredBaselineSequence", next_attempt_at AS "nextAttemptAt",
  last_error_code AS "lastErrorCode", retry_ordinal AS "retryOrdinal",
  failure_window_started_at AS "failureWindowStartedAt",
  failure_count_in_window AS "failureCountInWindow", last_failure_at AS "lastFailureAt",
  circuit_open_until AS "circuitOpenUntil", exclusion_counts_json AS "exclusionCountsJson",
  created_at AS "createdAt", started_at AS "startedAt",
  updated_at AS "updatedAt", completed_at AS "completedAt"
`;

export type ThreadRetentionRunRow = Omit<ThreadRetentionRun, "exclusionSummary"> & {
  readonly exclusionCountsJson: string | null;
};

export function toThreadRetentionRun(row: ThreadRetentionRunRow): ThreadRetentionRun {
  const { exclusionCountsJson, ...run } = row;
  return { ...run, exclusionSummary: decodeRetentionExclusionSummary(exclusionCountsJson) };
}
