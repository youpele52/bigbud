import type {
  EventLogFloorHolder,
  EventLogMaintenanceProgress,
} from "@bigbud/contracts/server/eventLogMaintenance.ts";

export interface EventLogMaintenanceSummary {
  readonly text: string;
  readonly details: ReadonlyArray<string>;
  /** Amber when maintenance has fallen behind or been blocked for a day, or keeps failing. */
  readonly tone: "muted" | "warning";
  readonly badge: string | null;
}

const count = (value: number) => Math.round(value).toLocaleString("en-US");

const timeOf = (iso: string | null) => (iso === null ? null : new Date(iso).toLocaleString());

/** Plain-language names for what keeps old history from being cleaned. */
const HOLDER_LABELS: Record<EventLogFloorHolder, string> = {
  baseline: "a saved snapshot that has not been verified",
  projector: "a view of your threads that is behind",
  reactor: "an internal event stream that is behind",
  delivery: "an open app connection that is behind",
  "hot-window": "recent history",
  cleanup: "an unfinished deletion cleanup",
  "turn-start": "a turn that never started",
  organization: "an organisation undo",
  workspace: "an unfinished workspace operation",
};

/** One line for Settings > Diagnostics, plus the backlog, rate and last error. */
export function describeEventLogMaintenance(
  progress: EventLogMaintenanceProgress | null | undefined,
): EventLogMaintenanceSummary {
  if (!progress) {
    return { text: "Not reported by this server.", details: [], tone: "muted", badge: null };
  }
  const details = [
    `Backlog: ${count(progress.backlogSequences)} events`,
    `Rate: ${count(progress.ratePerMinute)} per minute`,
  ];
  const lastBatch = timeOf(progress.lastBatchAt);
  if (lastBatch) details.push(`Last batch: ${lastBatch}`);
  if (progress.lastError) details.push(`Last error: ${progress.lastError.split("\n")[0]}`);

  if (progress.starved) {
    const since = timeOf(progress.starvedSince);
    return {
      text: `Old history is building up faster than it is cleaned${since ? ` (since ${since})` : ""}.`,
      details,
      tone: "warning",
      badge: "Falling behind",
    };
  }
  if (progress.floorPinned === true && progress.state !== "disabled") {
    const since = timeOf(progress.floorPinnedSince ?? null);
    // Only deletions verify a checkpoint today, so this one is expected after a quiet stretch.
    if (progress.floorHeldBy === "baseline") {
      return {
        text: `Old history is waiting for a saved database checkpoint${since ? ` (since ${since})` : ""}.`,
        details,
        tone: "warning",
        badge: "Waiting for checkpoint",
      };
    }
    const holder = progress.floorHeldBy ? HOLDER_LABELS[progress.floorHeldBy] : "another task";
    return {
      text: `Old history can't be cleaned: held by ${holder}${since ? ` since ${since}` : ""}.`,
      details,
      tone: "warning",
      badge: "Cleanup blocked",
    };
  }
  switch (progress.state) {
    case "disabled":
      return { text: "Turned off for this server.", details: [], tone: "muted", badge: null };
    case "waiting":
      return { text: "Starts a few minutes after launch.", details, tone: "muted", badge: null };
    case "backing-off":
      return {
        text: `Paused after an error; retrying at ${timeOf(progress.backoffUntil) ?? "a later tick"}.`,
        details,
        tone: "warning",
        badge: "Retrying",
      };
    case "draining":
      return {
        text: "Cleaning old history in small batches.",
        details,
        tone: "muted",
        badge: null,
      };
    case "idle":
      return { text: "Up to date.", details, tone: "muted", badge: null };
  }
}
