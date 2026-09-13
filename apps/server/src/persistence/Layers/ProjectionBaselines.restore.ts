import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

function rowKey(row: Record<string, unknown>, columns: ReadonlyArray<TableColumn>) {
  return columns.map((column) => row[column.name]);
}

export function defaultExpression(column: TableColumn): string {
  return column.defaultValue ?? "NULL";
}

export function deleteMissingRows(
  table: string,
  columns: ReadonlyArray<TableColumn>,
  payloadRows: ReadonlyArray<Record<string, unknown>>,
): { readonly statement: string; readonly params: ReadonlyArray<unknown> } {
  const primaryKey = columns
    .filter((column) => column.primaryKeyPosition > 0)
    .toSorted((left, right) => left.primaryKeyPosition - right.primaryKeyPosition);
  if (primaryKey.length === 0) throw new Error(`baseline table ${table} has no primary key`);
  const keys = payloadRows
    .filter((row) => primaryKey.every((column) => Object.hasOwn(row, column.name)))
    .map((row) => rowKey(row, primaryKey));
  const projectGuard = table === "projection_projects" ? ` WHERE project_id <> '__chats__'` : "";
  if (keys.length === 0) return { statement: `DELETE FROM ${table}${projectGuard}`, params: [] };
  const encodedKeys = JSON.stringify(keys);
  const keySql = `json_array(${primaryKey.map((column) => quoteIdentifier(column.name)).join(", ")})
    NOT IN (SELECT payload_key.value FROM json_each(?) AS payload_key)`;
  return {
    statement: `DELETE FROM ${table}${projectGuard}${projectGuard ? " AND " : " WHERE "}${keySql}`,
    params: [encodedKeys],
  };
}

export function hasDuplicatePrimaryKeys(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<TableColumn>,
): boolean {
  const primaryKey = columns
    .filter((column) => column.primaryKeyPosition > 0)
    .toSorted((left, right) => left.primaryKeyPosition - right.primaryKeyPosition);
  const seen = new Set<string>();
  for (const row of rows) {
    if (!primaryKey.every((column) => Object.hasOwn(row, column.name))) continue;
    const key = JSON.stringify(rowKey(row, primaryKey));
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
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
