import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import { PROJECTION_BASELINE_TABLES } from "../ProjectionBaselineSchema.ts";
import {
  forEachBaselinePayloadPage,
  makeBaselinePayloadHasher,
} from "../ProjectionBaselineRows.ts";
import type { BaselinePayloadSource } from "../Services/ProjectionBaselines.ts";
import { decodeBaselineRow, makeThreadOwnedRowFilter } from "./ProjectionBaselines.payload.ts";
import {
  countDistinctBaselineRestoreKeys,
  defaultExpression,
  deleteRowsMissingFromKeys,
  hasBaselineSurrogateKey,
  primaryKeyColumns,
  quoteIdentifier,
  recordBaselineRestoreKeys,
  resetBaselineRestoreKeys,
  restoreActiveWatches,
  type ActiveWatch,
  type TableColumn,
} from "./ProjectionBaselines.restore.ts";

const decodeError = (stage: string) =>
  toPersistenceDecodeCauseError(`ProjectionBaselineRepository.restorePayload:${stage}`);

const decodePage = (table: string, rows: ReadonlyArray<{ readonly rowJson: string }>) =>
  Effect.try({
    try: () => rows.map((row) => decodeBaselineRow(table, row.rowJson)),
    catch: decodeError("decode"),
  });

const readTableColumns = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tableColumns = new Map<string, ReadonlyArray<TableColumn>>();
    for (const table of PROJECTION_BASELINE_TABLES) {
      const columns = yield* sql.unsafe<{
        readonly name: string;
        readonly pk: number;
        readonly dflt_value: string | null;
      }>(`PRAGMA table_info(${table})`);
      tableColumns.set(
        table,
        columns.map((column) => ({
          name: column.name,
          primaryKeyPosition: column.pk,
          defaultValue: column.dflt_value,
        })),
      );
    }
    return tableColumns;
  });

const insertRow = (
  sql: SqlClient.SqlClient,
  table: string,
  schemaColumns: ReadonlyArray<TableColumn>,
  row: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const columns = schemaColumns.map((column) => column.name);
    const allowedColumns = new Set(columns);
    if (columns.length === 0 || Object.keys(row).some((column) => !allowedColumns.has(column))) {
      return yield* decodeError("columns")(new Error(`invalid columns for ${table}`));
    }
    const valueExpressions = schemaColumns.map((column) =>
      Object.hasOwn(row, column.name) ? "?" : defaultExpression(column),
    );
    const values = columns
      .filter((column) => Object.hasOwn(row, column))
      .map((column) => row[column]);
    const updates = schemaColumns
      .filter((column) => column.primaryKeyPosition === 0)
      .map((column) => `${quoteIdentifier(column.name)} = excluded.${quoteIdentifier(column.name)}`)
      .join(", ");
    // A surrogate-key table was emptied first: a conflict is a duplicate row and must fail.
    const onConflict = hasBaselineSurrogateKey(table)
      ? ""
      : updates.length > 0
        ? ` ON CONFLICT DO UPDATE SET ${updates}`
        : " ON CONFLICT DO NOTHING";
    yield* sql.unsafe(
      `INSERT INTO ${table} (${columns.map(quoteIdentifier).join(", ")}) ` +
        `VALUES (${valueExpressions.join(", ")})${onConflict}`,
      values,
    );
  });

/**
 * Restores a baseline from `source` with only one page of rows in memory at a time.
 *
 * Pass 1 hashes every row, validates thread ownership and records primary keys in a temp
 * table. A hash mismatch, malformed row or duplicate key fails here, before anything is
 * deleted. Pass 2 deletes rows that are not in the baseline and upserts the baseline rows.
 * Tables whose surrogate key baselines leave out (`projection_turns`) are emptied and
 * re-inserted instead, with SQLite assigning the key; a duplicate there fails the insert.
 * Everything runs in one transaction, so any failure leaves the projections untouched.
 */
export const restoreBaselinePayload = (
  sql: SqlClient.SqlClient,
  source: BaselinePayloadSource,
  sequence: number,
  requiredProjectors: ReadonlyArray<string>,
) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        const activeWatches = yield* sql<ActiveWatch>`
          SELECT watch_id AS "watchId", watcher_thread_id AS "watcherThreadId",
            watched_thread_id AS "watchedThreadId", watched_thread_title AS "watchedThreadTitle",
            source_message_id AS "sourceMessageId", status, created_at AS "createdAt",
            triggered_at AS "triggeredAt"
          FROM projection_thread_watches
          WHERE status = 'active'
        `;
        const tableColumns = yield* readTableColumns(sql);
        const hasher = makeBaselinePayloadHasher();
        const filter = makeThreadOwnedRowFilter();
        yield* resetBaselineRestoreKeys(sql);

        for (const table of PROJECTION_BASELINE_TABLES) {
          // No key to record when baselines leave the primary key out: the table is replaced.
          const primaryKey = hasBaselineSurrogateKey(table)
            ? null
            : primaryKeyColumns(tableColumns.get(table)!);
          let keyCount = 0;
          hasher.beginTable(table);
          yield* forEachBaselinePayloadPage(source, table, (rows) =>
            Effect.gen(function* () {
              rows.forEach((row) => hasher.row(row.rowJson));
              const decoded = yield* decodePage(table, rows);
              const keys = yield* Effect.try({
                try: () =>
                  decoded
                    .filter((row) => filter.accept(table, row))
                    .filter(
                      (row) =>
                        primaryKey !== null &&
                        primaryKey.every((column) => Object.hasOwn(row, column.name)),
                    )
                    .map((row) => primaryKey!.map((column) => row[column.name])),
                catch: decodeError("decode"),
              });
              keyCount += keys.length;
              yield* recordBaselineRestoreKeys(sql, table, keys);
            }),
          );
          hasher.endTable();
          if ((yield* countDistinctBaselineRestoreKeys(sql, table)) !== keyCount) {
            return yield* decodeError("duplicate")(
              new Error(`duplicate primary key in baseline ${table}`),
            );
          }
        }
        const digest = hasher.digest();
        if (source.payloadHash !== null && digest !== source.payloadHash) {
          return yield* decodeError("hash")(new Error("projection baseline payload hash mismatch"));
        }
        const sanitization = filter.sanitization();
        if (sanitization.length > 0) {
          yield* Effect.logWarning("legacy projection baseline rows sanitized", {
            tables: sanitization,
          });
        }

        for (const table of PROJECTION_BASELINE_TABLES.toReversed()) {
          const deletion = yield* Effect.try({
            try: () => deleteRowsMissingFromKeys(table, tableColumns.get(table)!),
            catch: decodeError("columns"),
          });
          yield* sql.unsafe(deletion.statement, deletion.params);
        }
        for (const table of PROJECTION_BASELINE_TABLES) {
          const schemaColumns = tableColumns.get(table)!;
          yield* forEachBaselinePayloadPage(source, table, (rows) =>
            Effect.gen(function* () {
              for (const payloadRow of yield* decodePage(table, rows)) {
                if (!filter.keeps(table, payloadRow)) continue;
                const row =
                  table === "projection_threads" &&
                  payloadRow.parent_thread_id !== null &&
                  !filter.restoredThreadIds.has(payloadRow.parent_thread_id as string)
                    ? Object.assign({}, payloadRow, {
                        parent_thread_id: null,
                        parent_thread_title: null,
                        parent_thread_project_id: null,
                      })
                    : payloadRow;
                yield* insertRow(sql, table, schemaColumns, row);
              }
            }),
          );
        }
        yield* resetBaselineRestoreKeys(sql);

        yield* sql`
          UPDATE projection_threads
          SET parent_thread_id = NULL, parent_thread_title = NULL, parent_thread_project_id = NULL
          WHERE parent_thread_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM projection_threads AS parent
              WHERE parent.thread_id = projection_threads.parent_thread_id
            )
        `;
        yield* sql`UPDATE projection_organization_age_backfill SET after_thread_id = '',
          thread_id = NULL, revision = 0, event_cursor = 0, observed_revision = 0,
          anchor = NULL, last_changed_at = NULL, invalid = 0 WHERE singleton = 1`;
        yield* sql`DELETE FROM projection_state`;
        yield* sql`UPDATE projection_usage_backfill_state
          SET last_activity_id = '', completed = 0`;
        yield* sql`UPDATE projection_usage_estimate_backfill_state
          SET last_message_id = '', completed = 0`;
        const updatedAt = new Date().toISOString();
        for (const projector of requiredProjectors) {
          yield* sql`
            INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
            VALUES (${projector}, ${sequence}, ${updatedAt})
          `;
        }
        yield* restoreActiveWatches(sql, activeWatches);
      }),
    )
    .pipe(
      Effect.mapError((error) =>
        error._tag === "PersistenceDecodeError"
          ? error
          : toPersistenceSqlError("ProjectionBaselineRepository.restorePayload")(error),
      ),
    );
