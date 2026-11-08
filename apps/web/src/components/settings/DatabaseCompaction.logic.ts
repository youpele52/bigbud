import type {
  DatabaseCompactionBlocker,
  DatabaseCompactionPreview,
  DatabaseCompactionRun,
  DatabaseCompactionStatus,
} from "@bigbud/contracts/server/databaseCompaction.ts";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

export function formatDatabaseBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
}

export function formatCompactionDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return seconds === 1 ? "about 1 second" : `about ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}

export const DATABASE_COMPACTION_BLOCKER_LABELS: Record<DatabaseCompactionBlocker, string> = {
  "below-threshold":
    "Free space is too small to be worth compacting (it must exceed 25% of the file and 500 MB).",
  "insufficient-disk": "Not enough free disk space: compaction needs at least the database size.",
  "disk-unknown": "Free disk space could not be read, so compaction cannot start safely.",
  "running-turns": "A turn is running. Wait for it to finish before compacting.",
  "maintenance-backlog":
    "History cleanup is still removing old events. Compact once it has caught up for the biggest saving.",
  "already-running": "Database compaction is already running.",
  "in-process-sqlite":
    "This backend runs SQLite on its main thread (development mode, BIGBUD_SQLITE_WORKER=0 or a missing worker), so compaction would freeze it. Run it from a backend that uses the SQLite worker.",
};

export interface CompactionRowState {
  readonly summary: string;
  readonly actionEnabled: boolean;
}

/** The row's status line and whether its button opens the preview. */
export function describeCompactionRow(input: {
  readonly preview: DatabaseCompactionPreview | null;
  readonly error: string | null;
  readonly running: boolean;
}): CompactionRowState {
  if (input.running) return { summary: "Compacting the database…", actionEnabled: false };
  if (input.error) return { summary: "Database size is unavailable.", actionEnabled: false };
  const preview = input.preview;
  if (!preview) return { summary: "Checking database size…", actionEnabled: false };
  const size = formatDatabaseBytes(preview.fileBytes);
  const free = formatDatabaseBytes(preview.freeBytes);
  const percent = Math.round(preview.freeFraction * 100);
  if (!preview.offered) {
    return {
      summary: `${size} · ${free} free (${percent}%). Nothing worth compacting right now.`,
      actionEnabled: false,
    };
  }
  return {
    summary: `${size} · ${free} free (${percent}%) · about ${formatDatabaseBytes(preview.expectedBytes)} after compaction`,
    actionEnabled: true,
  };
}

export interface CompactionPreviewItem {
  readonly label: string;
  readonly value: string;
}

export function getCompactionPreviewItems(
  preview: DatabaseCompactionPreview,
): ReadonlyArray<CompactionPreviewItem> {
  return [
    { label: "Current size", value: formatDatabaseBytes(preview.fileBytes + preview.walBytes) },
    {
      label: "Free pages",
      value: `${formatDatabaseBytes(preview.freeBytes)} (${Math.round(preview.freeFraction * 100)}%)`,
    },
    { label: "Expected size after", value: formatDatabaseBytes(preview.expectedBytes) },
    {
      label: "Free disk space",
      value:
        preview.diskFreeBytes === null
          ? "Unknown"
          : `${formatDatabaseBytes(preview.diskFreeBytes)} (needs ${formatDatabaseBytes(preview.requiredDiskBytes)})`,
    },
    { label: "Estimated duration", value: formatCompactionDuration(preview.estimatedDurationMs) },
  ];
}

export interface CompactionConfirmState {
  readonly canConfirm: boolean;
  readonly blockers: ReadonlyArray<string>;
}

export function getCompactionConfirmState(input: {
  readonly preview: DatabaseCompactionPreview | null;
  readonly previewBusy: boolean;
  readonly actionBusy: boolean;
}): CompactionConfirmState {
  const blockers = (input.preview?.blockers ?? []).map(
    (blocker) => DATABASE_COMPACTION_BLOCKER_LABELS[blocker],
  );
  return {
    canConfirm:
      !input.previewBusy && !input.actionBusy && input.preview !== null && blockers.length === 0,
    blockers,
  };
}

export interface CompactionToast {
  readonly type: "loading" | "success" | "warning" | "error";
  readonly title: string;
  readonly description?: string;
}

export function getCompactionRunToast(run: DatabaseCompactionRun): CompactionToast {
  if (run.outcome === "failed")
    return {
      type: "error",
      title: "Database compaction failed",
      description: `${run.error ?? "An error occurred."} The database was not changed.`,
    };
  if (run.outcome === "interrupted")
    return {
      type: "warning",
      title: "Database compaction was interrupted",
      description: run.error
        ? `${run.error} You can try again.`
        : "The backend stopped before compaction finished. The database was left as it was; you can try again.",
    };
  const sizes =
    run.bytesBefore !== null && run.bytesAfter !== null
      ? `${formatDatabaseBytes(run.bytesBefore)} → ${formatDatabaseBytes(run.bytesAfter)}`
      : "Free space was returned to disk.";
  // A completed run with an error finished its rebuild but could not clean up after itself.
  if (run.error)
    return { type: "warning", title: "Database compacted", description: `${sizes} ${run.error}` };
  return run.checkpointComplete
    ? { type: "success", title: "Database compacted", description: sizes }
    : {
        type: "warning",
        title: "Database compacted",
        description: `${sizes} The last part of the cleanup finishes in the background.`,
      };
}

/** Identifies a finished run, so its toast is shown once across remounts and reloads. */
export const compactionRunKey = (run: DatabaseCompactionRun) => `${run.startedAt}:${run.outcome}`;

export function getCompactionLoaderMessage(
  status: DatabaseCompactionStatus | null,
  reconnecting: boolean,
): { readonly title: string; readonly detail: string } {
  if (reconnecting)
    return {
      title: "Compacting the database",
      detail: "Waiting for the backend to answer. This screen closes when compaction finishes.",
    };
  const phase =
    status?.phase === "checkpointing"
      ? "Writing the compacted file to disk."
      : status?.phase === "preparing"
        ? "Checking that it is safe to start."
        : "Rebuilding the database without its free space.";
  const estimate =
    status?.estimatedDurationMs !== null && status?.estimatedDurationMs !== undefined
      ? ` It takes ${formatCompactionDuration(status.estimatedDurationMs)}.`
      : "";
  return {
    title: "Compacting the database",
    detail: `${phase}${estimate} bigbud is paused until it finishes, and your threads are safe.`,
  };
}
