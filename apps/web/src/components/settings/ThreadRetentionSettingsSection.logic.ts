import { THREAD_RETENTION_POLICY_LABELS } from "@bigbud/contracts/core/settings.threadRetention";
import type {
  ServerThreadRetentionResult,
  ServerThreadRetentionRun,
  ThreadRetentionMaintenanceState,
} from "@bigbud/contracts/server/threadRetention";

export const ACTIVE_RETENTION_RUN_STATUSES = new Set<ServerThreadRetentionRun["status"]>([
  "queued",
  "selecting",
  "preparing",
  "purging",
  "deferred",
]);

export const RETENTION_POLL_INTERVAL_MS = 2_000;
export const RETENTION_DEFERRED_POLL_INTERVAL_MS = 5_000;
export const RETENTION_LATEST_RUN_POLL_INTERVAL_MS = 5_000;

export function isActiveRetentionRun(run: ServerThreadRetentionRun): boolean {
  return ACTIVE_RETENTION_RUN_STATUSES.has(run.status);
}

export function getRetentionPollIntervalMs(run: ServerThreadRetentionRun): number | null {
  if (!isActiveRetentionRun(run)) return null;
  return run.status === "deferred"
    ? RETENTION_DEFERRED_POLL_INTERVAL_MS
    : RETENTION_POLL_INTERVAL_MS;
}

export function shouldReplaceRetentionRun(
  current: ServerThreadRetentionRun | null,
  candidate: ServerThreadRetentionRun,
): boolean {
  if (!current) return true;
  if (current.runId !== candidate.runId) {
    return Date.parse(candidate.createdAt) >= Date.parse(current.createdAt);
  }
  return Date.parse(candidate.updatedAt) >= Date.parse(current.updatedAt);
}

export function formatRetentionRunStatus(status: ServerThreadRetentionRun["status"]): string {
  return status.replaceAll("_", " ");
}

export function getRetentionRunStatusMessage(run: ServerThreadRetentionRun): string {
  switch (run.status) {
    case "queued":
      return run.trigger === "manual"
        ? "Manual cleanup is starting now."
        : "Scheduled cleanup is starting now.";
    case "deferred":
      return "Cleanup is paused — it will retry automatically when safe.";
    case "selecting":
    case "preparing":
    case "purging":
      return "Cleanup in progress — updates appear automatically.";
    default:
      return `Latest cleanup: ${formatRetentionRunStatus(run.status)}`;
  }
}

export function getRetentionMaintenanceMessage(
  state: ThreadRetentionMaintenanceState,
): string | null {
  switch (state) {
    case "available":
      return null;
    case "scheduled_active":
      return "Scheduled cleanup is active. This manual cleanup runs now.";
    case "manual_active":
      return "Another manual cleanup is active. This manual cleanup runs now.";
    case "safety_deferred":
      return "Cleanup is waiting for safety or recovery work to finish before this request can start.";
  }
}

export function formatRetentionExclusionReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

const RETENTION_EXCLUSION_REASON_LABELS: Readonly<Record<string, string>> = {
  already_deleted: "already deleted",
  deleting: "being deleted",
  pinned: "pinned",
  project_unavailable: "project removed",
  project_deleting: "project being deleted",
  remote_cleanup_unavailable: "on a remote workspace",
  // A turn in progress, a live terminal or shell, or an active browser or computer-use lease.
  running: "work in progress",
  pending_work: "queued or pending work",
  waiting_for_user: "waiting for your reply",
  active_task: "unfinished task",
  automation_owned: "owned by an automation",
  scheduled: "scheduled automation",
  activity_changed: "new activity since selection",
  policy_changed: "cleanup period changed",
  blocked_by_descendant: "held by a newer or busy child thread",
};

export function getRetentionExclusionReasonLabel(reason: string): string {
  return RETENTION_EXCLUSION_REASON_LABELS[reason] ?? formatRetentionExclusionReason(reason);
}

/**
 * Why a finished run deleted what it did, e.g. "216 older than 3 days · 26 skipped: on a
 * remote workspace". Soft-deleted rows are not threads the user sees, so they are not listed.
 * Empty for runs recorded before the breakdown existed.
 */
export function formatRetentionRunBreakdown(run: ServerThreadRetentionRun): string {
  if (run.olderThanCutoffCount === undefined) return "";
  const skipped = (run.exclusionCounts ?? [])
    .filter((exclusion) => exclusion.reason !== "already_deleted" && exclusion.count > 0)
    .toSorted((left, right) => right.count - left.count)
    .map(
      (exclusion) =>
        `${exclusion.count} skipped: ${getRetentionExclusionReasonLabel(exclusion.reason)}`,
    );
  return [
    `${run.olderThanCutoffCount} older than ${THREAD_RETENTION_POLICY_LABELS[run.policy]}`,
    ...skipped,
  ].join(" · ");
}

export function formatLatestRetentionCleanup(run: ServerThreadRetentionRun): string {
  const breakdown = formatRetentionRunBreakdown(run);
  return [
    `Latest cleanup: ${run.completedCount} threads deleted`,
    ...(breakdown ? [breakdown] : []),
    formatRetentionRunStatus(run.status),
  ].join(" · ");
}

export function formatRetentionCutoff(cutoffAt: string): string {
  return new Date(cutoffAt).toISOString();
}

export function getRetentionCleanupLoadingToast(): { readonly title: string } {
  return { title: "Deleting eligible threads…" };
}

export function formatRetentionCleanupResult(result: ServerThreadRetentionResult): string {
  if (result.pendingCount > 0) {
    return `Deleted ${result.deletedCount} threads and skipped ${result.skippedCount}. ${result.pendingCount} deletion outcomes could not be confirmed.`;
  }
  return `Deleted ${result.deletedCount} threads and skipped ${result.skippedCount}.`;
}

export function getRetentionCleanupSuccessToast(result: ServerThreadRetentionResult): {
  readonly title: string;
  readonly description: string;
} {
  return {
    title: result.pendingCount > 0 ? "Thread cleanup needs attention" : "Thread cleanup finished",
    description: formatRetentionCleanupResult(result),
  };
}

export function getRetentionPolicyUpdatedToast(): {
  readonly title: string;
  readonly description: string;
} {
  return {
    title: "Automatic cleanup updated",
    description: "The server will use the new period on its next daily check.",
  };
}

export function formatRetentionBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${Math.round(bytes / (1_024 * 1_024))} MB`;
}
