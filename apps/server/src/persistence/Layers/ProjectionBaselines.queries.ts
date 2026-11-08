import { Effect, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import { PROJECTION_BASELINE_FORMAT_VERSION } from "../ProjectionBaselineRows.ts";

/**
 * Rows read per statement while capturing a baseline table. Each page crosses the SQLite
 * worker boundary as one structured-clone message, so this bounds that message instead of
 * shipping a whole table (all messages and activities) in a single `.all()` result.
 */
export const BASELINE_CAPTURE_PAGE_ROWS = 1_000;

const PAGE_ROWID_COLUMN = "__bigbud_baseline_rowid";

const quoteTable = (table: string) => `"${table.replaceAll('"', '""')}"`;

/**
 * The two page statements. The continuation must constrain `rowid` alone: any extra
 * disjunct (such as `? IS NULL OR rowid > ?`) stops SQLite from seeking the rowid index,
 * so every page would rescan the table and the capture would turn quadratic.
 */
export const baselinePageStatements = (table: string) => {
  const select = `SELECT rowid AS ${PAGE_ROWID_COLUMN}, * FROM ${quoteTable(table)}`;
  return {
    first: `${select} ORDER BY rowid LIMIT ?`,
    next: `${select} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  };
};

const hasRowid = (sql: SqlClient.SqlClient, table: string) =>
  sql
    .unsafe<{ readonly sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table],
    )
    .pipe(Effect.map((rows) => !/\bWITHOUT\s+ROWID\b/i.test(rows[0]?.sql ?? "")));

/**
 * Passes every row of a baseline table to `onPage` in rowid-ordered pages, inside one
 * transaction, so the rows form the same consistent snapshot a single `SELECT *` returned.
 * Only one page is alive at a time. Tables declared `WITHOUT ROWID` cannot be paged by rowid
 * and are read in one statement; none of them hold conversation content.
 */
export const forEachBaselineTablePage = <E, R>(
  sql: SqlClient.SqlClient,
  table: string,
  onPage: (rows: ReadonlyArray<Record<string, unknown>>) => Effect.Effect<void, E, R>,
  pageRows: number = BASELINE_CAPTURE_PAGE_ROWS,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* hasRowid(sql, table))) {
        return yield* onPage(
          yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${quoteTable(table)}`),
        );
      }
      const statements = baselinePageStatements(table);
      let after: number | null = null;
      for (;;) {
        const page: ReadonlyArray<Record<string, unknown>> = yield* sql.unsafe<
          Record<string, unknown>
        >(
          after === null ? statements.first : statements.next,
          after === null ? [pageRows] : [after, pageRows],
        );
        const rows = page.map((pageRow) => {
          const { [PAGE_ROWID_COLUMN]: rowid, ...row } = pageRow;
          after = Number(rowid);
          return row;
        });
        if (rows.length > 0) yield* onPage(rows);
        if (page.length < pageRows) return;
      }
    }),
  );

/**
 * Reads only the sequence of the newest verified baseline. Coverage checks need nothing
 * else, and loading the full row also validates, hashes and parses the whole payload in
 * JavaScript. Each baseline is still checked once per process before it counts as coverage:
 * it must be in the row format with a well-formed hash. The full hash is checked whenever the
 * rows are actually read, by restore.
 */
export const makeLatestVerifiedSequence = (sql: SqlClient.SqlClient) => {
  const checkedBaselineIds = new Set<number>();
  return () =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe<{ readonly baselineId: number; readonly sequence: number }>(
          `SELECT baseline_id AS baselineId, sequence FROM projection_baselines
           WHERE verification_status = 'verified' ORDER BY sequence DESC LIMIT 1`,
        )
        .pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionBaselineRepository.latestVerifiedSequence"),
          ),
        );
      const latest = rows[0];
      if (latest === undefined) return Option.none<number>();
      if (!checkedBaselineIds.has(latest.baselineId)) {
        const checks = yield* sql
          .unsafe<{ readonly intact: number }>(
            `SELECT format_version = ? AND length(payload_hash) = 64 AS intact
             FROM projection_baselines WHERE baseline_id = ?`,
            [PROJECTION_BASELINE_FORMAT_VERSION, latest.baselineId],
          )
          .pipe(
            Effect.mapError(
              toPersistenceSqlError("ProjectionBaselineRepository.latestVerifiedSequence"),
            ),
          );
        if (checks[0]?.intact !== 1) {
          return yield* toPersistenceDecodeCauseError(
            "ProjectionBaselineRepository.latestVerifiedSequence:validate",
          )(new Error(`verified projection baseline ${latest.baselineId} is not intact`));
        }
        checkedBaselineIds.add(latest.baselineId);
      }
      return Option.some(latest.sequence);
    });
};
