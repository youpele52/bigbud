import { createHash } from "node:crypto";

import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "./Errors.ts";
import { PROJECTION_BASELINE_TABLES } from "./ProjectionBaselineSchema.ts";
import type { BaselinePayloadRow, BaselinePayloadSource } from "./Services/ProjectionBaselines.ts";

/**
 * Format 2 stores one `projection_baseline_rows` row per projection row. Format 1 stored the
 * whole payload as one JSON string, which crashed the backend once it reached ~150 MB.
 */
export const PROJECTION_BASELINE_FORMAT_VERSION = 2;

/** Stored rows read per statement. Bounds every page that crosses the SQLite worker. */
export const BASELINE_PAYLOAD_PAGE_ROWS = 500;

/** Rows captured only to compute a digest. AUTOINCREMENT ids start at 1, so 0 is never real. */
export const BASELINE_SCRATCH_ID = 0;

/**
 * Incremental sha256 over the canonical payload document
 * `{"tables":{"<table>":[<row>,…],…}}`, with tables in `PROJECTION_BASELINE_TABLES` order and
 * rows in stored ordinal order. It is byte-identical to the format 1 JSON string, so hashes
 * keep their meaning across the format change.
 */
export function makeBaselinePayloadHasher() {
  const hash = createHash("sha256").update('{"tables":{');
  let tableCount = 0;
  let rowCount = 0;
  return {
    beginTable(table: string) {
      hash.update(`${tableCount === 0 ? "" : ","}${JSON.stringify(table)}:[`);
      tableCount += 1;
      rowCount = 0;
    },
    row(rowJson: string) {
      hash.update(rowCount === 0 ? rowJson : `,${rowJson}`);
      rowCount += 1;
    },
    endTable() {
      hash.update("]");
    },
    digest() {
      return hash.update("}}").digest("hex");
    },
  };
}

/** Calls `onPage` with each page of one table, in ordinal order. */
export const forEachBaselinePayloadPage = <E, R>(
  source: BaselinePayloadSource,
  table: string,
  onPage: (rows: ReadonlyArray<BaselinePayloadRow>) => Effect.Effect<void, E, R>,
  pageRows: number = BASELINE_PAYLOAD_PAGE_ROWS,
) =>
  Effect.gen(function* () {
    let after = -1;
    for (;;) {
      const page = yield* source.readTablePage(table, after, pageRows);
      if (page.length > 0) {
        yield* onPage(page);
        after = page.at(-1)!.ordinal;
      }
      if (page.length < pageRows) return;
    }
  });

export const hashBaselinePayload = (source: BaselinePayloadSource) =>
  Effect.gen(function* () {
    const hasher = makeBaselinePayloadHasher();
    for (const table of PROJECTION_BASELINE_TABLES) {
      hasher.beginTable(table);
      yield* forEachBaselinePayloadPage(source, table, (rows) =>
        Effect.sync(() => rows.forEach((row) => hasher.row(row.rowJson))),
      );
      hasher.endTable();
    }
    return hasher.digest();
  });

export const storedBaselinePayloadSource = (
  sql: SqlClient.SqlClient,
  baselineId: number,
  payloadHash: string | null,
): BaselinePayloadSource => ({
  payloadHash,
  readTablePage: (table, afterOrdinal, limit) =>
    sql
      .unsafe<BaselinePayloadRow>(
        `SELECT ordinal, row_json AS "rowJson" FROM projection_baseline_rows
         WHERE baseline_id = ? AND table_name = ? AND ordinal > ?
         ORDER BY ordinal LIMIT ?`,
        [baselineId, table, afterOrdinal, limit],
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectionBaselineRows.readTablePage"))),
});

/**
 * Copies a baseline's rows into another database page by page, for example from the live
 * database into a verification workspace. Must not run inside a transaction on `target`:
 * Effect's transaction connection is not scoped per client, so `source` reads issued inside a
 * `target` transaction would silently run against `target`.
 */
export const copyBaselinePayloadRows = (
  source: BaselinePayloadSource,
  target: SqlClient.SqlClient,
  baselineId: number,
) =>
  Effect.gen(function* () {
    yield* target.unsafe("DELETE FROM projection_baseline_rows WHERE baseline_id = ?", [
      baselineId,
    ]);
    for (const table of PROJECTION_BASELINE_TABLES) {
      yield* forEachBaselinePayloadPage(source, table, (rows) =>
        target.unsafe(
          `INSERT INTO projection_baseline_rows (baseline_id, table_name, ordinal, row_json)
           VALUES ${rows.map(() => "(?, ?, ?, ?)").join(", ")}`,
          rows.flatMap((row) => [baselineId, table, row.ordinal, row.rowJson]),
        ),
      );
    }
  });

export const emptyBaselinePayloadSource: BaselinePayloadSource = {
  payloadHash: null,
  readTablePage: () => Effect.succeed([]),
};
