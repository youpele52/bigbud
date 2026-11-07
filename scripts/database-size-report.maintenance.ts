/**
 * Event-log maintenance progress for the size report, read from the server's
 * `event_log_maintenance_state` row (migration 156) on the read-only connection.
 */
import type { DatabaseSync } from "node:sqlite";

import { formatCount, formatLabeledRows } from "./lib/report-cli.ts";

export interface MaintenanceProgress {
  readonly floorSequence: number;
  readonly floorHeldBy: string | null;
  readonly backlogSequences: number;
  readonly starved: boolean;
  readonly starvedSince: string | null;
  readonly lastBatchAt: string | null;
  readonly longestBatchMs: number;
  readonly ratePerMinute: number;
  readonly eventsDeleted: number;
  readonly gapsDeleted: number;
  readonly receiptsDeleted: number;
  readonly claimsDeleted: number;
  readonly eventIdsDeleted: number;
  readonly receiptsThroughSequence: number;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly backoffUntil: string | null;
  readonly updatedAt: string;
}

type Row = Record<string, unknown>;
const num = (value: unknown) => Number(value ?? 0);
const text = (value: unknown) => (value == null ? null : String(value));
const or = (value: string | null) => value ?? "none";

/** Null when the database predates maintenance (no state table yet). */
export function readMaintenanceProgress(db: DatabaseSync): MaintenanceProgress | null {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("event_log_maintenance_state");
  if (!exists) return null;
  const row = db
    .prepare("SELECT * FROM event_log_maintenance_state WHERE singleton_id = 1")
    .get() as Row | undefined;
  if (!row) return null;
  return {
    floorSequence: num(row.floor_sequence),
    floorHeldBy: text(row.floor_held_by),
    backlogSequences: num(row.backlog_sequences),
    starved: num(row.starved) === 1,
    starvedSince: text(row.starved_since),
    lastBatchAt: text(row.last_batch_at),
    longestBatchMs: num(row.longest_batch_ms),
    ratePerMinute: num(row.rate_per_minute),
    eventsDeleted: num(row.events_deleted),
    gapsDeleted: num(row.gaps_deleted),
    receiptsDeleted: num(row.receipts_deleted),
    claimsDeleted: num(row.claims_deleted),
    eventIdsDeleted: num(row.event_ids_deleted),
    receiptsThroughSequence: num(row.receipts_through_sequence),
    lastError: text(row.last_error),
    lastErrorAt: text(row.last_error_at),
    backoffUntil: text(row.backoff_until),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function formatMaintenanceProgress(progress: MaintenanceProgress | null): Array<string> {
  const lines = ["", "Event-log maintenance"];
  if (progress === null) return [...lines, "  not yet run on this database"];
  if (progress.starved) {
    lines.push(
      `  WARNING: the compaction backlog has grown for 24 hours (since ${progress.starvedSince ?? "unknown"}).`,
    );
  }
  lines.push(
    ...formatLabeledRows([
      ["Floor", formatCount(progress.floorSequence), `held by ${or(progress.floorHeldBy)}`],
      ["Backlog (sequences)", formatCount(progress.backlogSequences)],
      ["Rate (events/minute)", formatCount(Math.round(progress.ratePerMinute))],
      ["Last batch", or(progress.lastBatchAt)],
      ["Longest batch this run (ms)", progress.longestBatchMs.toFixed(1)],
      ["Events deleted", formatCount(progress.eventsDeleted)],
      ["Gap rows deleted", formatCount(progress.gapsDeleted)],
      [
        "Receipts / claims deleted",
        formatCount(progress.receiptsDeleted),
        formatCount(progress.claimsDeleted),
      ],
      ["Event IDs deleted", formatCount(progress.eventIdsDeleted)],
      ["Receipt cursor", formatCount(progress.receiptsThroughSequence)],
      ["Last error", or(progress.lastError?.split("\n")[0] ?? null), or(progress.lastErrorAt)],
      ["Backoff until", or(progress.backoffUntil)],
      ["Updated", progress.updatedAt],
    ]),
  );
  return lines;
}
