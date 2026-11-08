import { normalizeOrganizationAgeRow } from "./ProjectionBaselines.aging.ts";
import {
  PROJECTION_BASELINE_TABLES,
  PROJECTION_BASELINE_THREAD_OWNED_TABLES,
} from "../ProjectionBaselineSchema.ts";

export type BaselinePayload = {
  readonly tables: Record<string, ReadonlyArray<Record<string, unknown>>>;
};

export interface BaselineSanitization {
  readonly table: (typeof PROJECTION_BASELINE_THREAD_OWNED_TABLES)[number];
  readonly removedCount: number;
}

export function parseBaselinePayload(payloadJson: string): BaselinePayload {
  const value: unknown = JSON.parse(payloadJson);
  if (typeof value !== "object" || value === null || !("tables" in value)) {
    throw new Error("baseline payload has no tables object");
  }
  const tables = (value as { tables?: unknown }).tables;
  if (typeof tables !== "object" || tables === null) {
    throw new Error("baseline payload tables are invalid");
  }
  for (const table of PROJECTION_BASELINE_TABLES) {
    if (
      (table === "projection_usage_codex_state" ||
        table === "projection_usage_codex_retired_turns") &&
      !Object.hasOwn(tables, table)
    ) {
      (tables as Record<string, unknown>)[table] = [];
    }
    if (!Array.isArray((tables as Record<string, unknown>)[table])) {
      throw new Error(`baseline payload is missing ${table}`);
    }
  }
  (tables as BaselinePayload["tables"]).projection_threads = (
    tables as BaselinePayload["tables"]
  ).projection_threads!.map(normalizeOrganizationAgeRow);
  return value as BaselinePayload;
}

const THREAD_OWNED_TABLES: ReadonlySet<string> = new Set(PROJECTION_BASELINE_THREAD_OWNED_TABLES);

/** Decodes one stored baseline row, applying the same normalisation as `parseBaselinePayload`. */
export function decodeBaselineRow(table: string, rowJson: string): Record<string, unknown> {
  const row: unknown = JSON.parse(rowJson);
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`baseline ${table} row is not an object`);
  }
  const record = row as Record<string, unknown>;
  return table === "projection_threads" ? normalizeOrganizationAgeRow(record) : record;
}

/**
 * Drops thread-owned rows whose thread is not part of the restored baseline, one row at a
 * time. Rows must arrive in `PROJECTION_BASELINE_TABLES` order, where `projection_threads`
 * precedes every thread-owned table. Only bounded table counts are reported, never ids.
 */
export function makeThreadOwnedRowFilter() {
  const restoredThreadIds = new Set<string>();
  const removed = new Map<string, number>();
  return {
    restoredThreadIds: restoredThreadIds as ReadonlySet<string>,
    /** Returns whether the row is kept; throws for rows without a string `thread_id`. */
    accept(table: string, row: Record<string, unknown>): boolean {
      if (table === "projection_threads") {
        if (typeof row.thread_id !== "string") {
          throw new Error("baseline projection_threads row has an invalid thread_id");
        }
        restoredThreadIds.add(row.thread_id);
        return true;
      }
      if (!THREAD_OWNED_TABLES.has(table)) return true;
      if (typeof row.thread_id !== "string") {
        throw new Error(`baseline ${table} row has an invalid thread_id`);
      }
      if (restoredThreadIds.has(row.thread_id)) return true;
      removed.set(table, (removed.get(table) ?? 0) + 1);
      return false;
    },
    /** The decision `accept` made for an already accepted row, without recording it again. */
    keeps(table: string, row: Record<string, unknown>): boolean {
      return !THREAD_OWNED_TABLES.has(table) || restoredThreadIds.has(row.thread_id as string);
    },
    sanitization(): ReadonlyArray<BaselineSanitization> {
      return PROJECTION_BASELINE_THREAD_OWNED_TABLES.flatMap((table) => {
        const removedCount = removed.get(table) ?? 0;
        return removedCount > 0 ? [{ table, removedCount }] : [];
      });
    },
  };
}
