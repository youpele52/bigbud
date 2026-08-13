import type { ServerThreadRetentionRun } from "@bigbud/contracts/server/threadRetention";

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
      return "Cleanup request queued — it will start automatically when safe.";
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

export function formatRetentionExclusionReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

export function formatRetentionCutoff(cutoffAt: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(cutoffAt),
  );
}

export function formatRetentionBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${Math.round(bytes / (1_024 * 1_024))} MB`;
}
