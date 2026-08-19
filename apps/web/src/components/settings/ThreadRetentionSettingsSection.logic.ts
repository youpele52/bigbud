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

export function formatRetentionCutoff(cutoffAt: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(cutoffAt),
  );
}

export function getRetentionCleanupLoadingToast(): { readonly title: string } {
  return { title: "Deleting eligible threads…" };
}

export function getRetentionCleanupSuccessToast(result: ServerThreadRetentionResult): {
  readonly title: string;
  readonly description: string;
} {
  return {
    title: "Thread cleanup finished",
    description: `Deleted ${result.deletedCount} threads and skipped ${result.skippedCount}.`,
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
