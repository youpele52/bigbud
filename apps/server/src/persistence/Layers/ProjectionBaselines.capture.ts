import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROJECTION_BASELINE_TABLES } from "../ProjectionBaselineSchema.ts";
import { hashBaselinePayload, storedBaselinePayloadSource } from "../ProjectionBaselineRows.ts";
import { normalizeOrganizationAgeRow } from "./ProjectionBaselines.aging.ts";
import { forEachBaselineTablePage } from "./ProjectionBaselines.queries.ts";

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(row)
      .toSorted()
      .map((key) => [key, row[key]]),
  );
}

/** The baseline form of one live projection row, or `null` when it is not part of baselines. */
export function toBaselineRowJson(
  table: string,
  row: Record<string, unknown>,
  currentThreadIds: ReadonlySet<unknown>,
): string | null {
  if (table === "projection_projects") {
    return row.project_id === "__chats__" ? null : JSON.stringify(normalizeRow(row));
  }
  if (table !== "projection_threads") return JSON.stringify(normalizeRow(row));
  const parented =
    row.parent_thread_id === null || currentThreadIds.has(row.parent_thread_id)
      ? row
      : Object.assign({}, row, {
          parent_thread_id: null,
          parent_thread_title: null,
          parent_thread_project_id: null,
        });
  return JSON.stringify(normalizeRow(normalizeOrganizationAgeRow(parented)));
}

const CAPTURE_TABLE = "temp.projection_baseline_capture";

/**
 * Captures the current projections into `projection_baseline_rows` under `baselineId` and
 * returns the payload hash. Only one page of rows is in JavaScript at a time: pages are staged
 * in a temp table and SQLite assigns the sorted ordinals in one statement, spilling to disk
 * when needed. Ordering by the row text keeps the result independent of insertion order, so a
 * replayed workspace and the live database produce the same hash for the same state.
 */
export const captureBaselineRows = (sql: SqlClient.SqlClient, baselineId: number) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(`CREATE TEMP TABLE IF NOT EXISTS projection_baseline_capture (
        table_name TEXT NOT NULL, row_json TEXT NOT NULL)`);
      yield* sql.unsafe(`DELETE FROM ${CAPTURE_TABLE}`);
      yield* sql.unsafe("DELETE FROM projection_baseline_rows WHERE baseline_id = ?", [baselineId]);
      const threadRows = yield* sql.unsafe<{ readonly thread_id: unknown }>(
        "SELECT thread_id FROM projection_threads",
      );
      const currentThreadIds = new Set(threadRows.map((row) => row.thread_id));
      for (const table of PROJECTION_BASELINE_TABLES) {
        yield* forEachBaselineTablePage(sql, table, (page) => {
          const rowJsons = page.flatMap((row) => {
            const rowJson = toBaselineRowJson(table, row, currentThreadIds);
            return rowJson === null ? [] : [rowJson];
          });
          if (rowJsons.length === 0) return Effect.void;
          return sql.unsafe(
            `INSERT INTO ${CAPTURE_TABLE} (table_name, row_json)
             VALUES ${rowJsons.map(() => "(?, ?)").join(", ")}`,
            rowJsons.flatMap((rowJson) => [table, rowJson]),
          );
        });
      }
      yield* sql.unsafe(
        `INSERT INTO projection_baseline_rows (baseline_id, table_name, ordinal, row_json)
         SELECT ?, table_name,
           row_number() OVER (PARTITION BY table_name ORDER BY row_json) - 1, row_json
         FROM ${CAPTURE_TABLE}`,
        [baselineId],
      );
      yield* sql.unsafe(`DELETE FROM ${CAPTURE_TABLE}`);
      return yield* hashBaselinePayload(storedBaselinePayloadSource(sql, baselineId, null));
    }),
  );
