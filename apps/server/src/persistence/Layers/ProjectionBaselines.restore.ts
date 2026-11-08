import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROJECTION_BASELINE_SURROGATE_KEYS } from "../ProjectionBaselineSchema.ts";

export type TableColumn = {
  readonly name: string;
  readonly primaryKeyPosition: number;
  readonly defaultValue: string | null;
};

export type ActiveWatch = {
  readonly watchId: string;
  readonly watcherThreadId: string;
  readonly watchedThreadId: string;
  readonly watchedThreadTitle: string;
  readonly sourceMessageId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly triggeredAt: string | null;
};

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function defaultExpression(column: TableColumn): string {
  return column.defaultValue ?? "NULL";
}

export function primaryKeyColumns(columns: ReadonlyArray<TableColumn>): ReadonlyArray<TableColumn> {
  return columns
    .filter((column) => column.primaryKeyPosition > 0)
    .toSorted((left, right) => left.primaryKeyPosition - right.primaryKeyPosition);
}

/**
 * Primary keys of the rows being restored, recorded page by page so a restore never holds a
 * whole table's keys in memory. Keys are stored as SQLite-rendered JSON arrays, the same form
 * `json_array(<key columns>)` produces for live rows, so NULL key components compare exactly.
 */
export const BASELINE_RESTORE_KEYS_TABLE = "temp.projection_baseline_restore_keys";

export const resetBaselineRestoreKeys = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`CREATE TEMP TABLE IF NOT EXISTS projection_baseline_restore_keys (
      table_name TEXT NOT NULL, key_json TEXT NOT NULL)`);
    yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS temp.projection_baseline_restore_keys_lookup
      ON projection_baseline_restore_keys (table_name, key_json)`);
    yield* sql.unsafe(`DELETE FROM ${BASELINE_RESTORE_KEYS_TABLE}`);
  });

export const recordBaselineRestoreKeys = (
  sql: SqlClient.SqlClient,
  table: string,
  keys: ReadonlyArray<ReadonlyArray<unknown>>,
) =>
  keys.length === 0
    ? Effect.void
    : sql
        .unsafe(
          `INSERT INTO ${BASELINE_RESTORE_KEYS_TABLE} (table_name, key_json)
           SELECT ?, value FROM json_each(?)`,
          [table, JSON.stringify(keys)],
        )
        .pipe(Effect.asVoid);

export const countDistinctBaselineRestoreKeys = (sql: SqlClient.SqlClient, table: string) =>
  sql
    .unsafe<{ readonly count: number }>(
      `SELECT COUNT(DISTINCT key_json) AS count FROM ${BASELINE_RESTORE_KEYS_TABLE}
       WHERE table_name = ?`,
      [table],
    )
    .pipe(Effect.map((rows) => rows[0]?.count ?? 0));

/** Whether baselines leave out `table`'s surrogate key, so restore replaces the table whole. */
export function hasBaselineSurrogateKey(table: string): boolean {
  return Object.hasOwn(PROJECTION_BASELINE_SURROGATE_KEYS, table);
}

/**
 * Deletes live rows whose key was not recorded for `table`. One uncorrelated subquery. A table
 * whose surrogate key baselines leave out has no key to match rows by, so all its rows go and
 * the baseline rows are inserted afresh.
 */
export function deleteRowsMissingFromKeys(
  table: string,
  columns: ReadonlyArray<TableColumn>,
): { readonly statement: string; readonly params: ReadonlyArray<unknown> } {
  if (hasBaselineSurrogateKey(table)) return { statement: `DELETE FROM ${table}`, params: [] };
  const primaryKey = primaryKeyColumns(columns);
  if (primaryKey.length === 0) throw new Error(`baseline table ${table} has no primary key`);
  const projectGuard = table === "projection_projects" ? " AND project_id <> '__chats__'" : "";
  const keyColumns = primaryKey.map((column) => quoteIdentifier(column.name)).join(", ");
  return {
    statement: `DELETE FROM ${table} WHERE json_array(${keyColumns}) NOT IN (
      SELECT key_json FROM ${BASELINE_RESTORE_KEYS_TABLE} WHERE table_name = ?)${projectGuard}`,
    params: [table],
  };
}

export function restoreActiveWatches(
  sql: SqlClient.SqlClient,
  watches: ReadonlyArray<ActiveWatch>,
) {
  return Effect.gen(function* () {
    for (const watch of watches) {
      yield* sql`
        INSERT INTO projection_thread_watches (
          watch_id, watcher_thread_id, watched_thread_id, watched_thread_title,
          source_message_id, status, created_at, triggered_at
        )
        SELECT ${watch.watchId}, ${watch.watcherThreadId}, ${watch.watchedThreadId},
          ${watch.watchedThreadTitle}, ${watch.sourceMessageId}, ${watch.status},
          ${watch.createdAt}, ${watch.triggeredAt}
        WHERE EXISTS (
          SELECT 1 FROM projection_threads WHERE thread_id = ${watch.watcherThreadId}
        ) AND EXISTS (
          SELECT 1 FROM projection_threads WHERE thread_id = ${watch.watchedThreadId}
        )
        ON CONFLICT DO NOTHING
      `;
    }
  });
}
