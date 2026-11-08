/**
 * Rewrites the stored `projection_turns` rows of one baseline in place, for migrations that
 * change what a baseline turn row holds (157: recovered usage; 158: no `row_id`).
 *
 * @module ProjectionBaselineRows.turnRewrite
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "./Errors.ts";
import {
  forEachBaselinePayloadPage,
  makeBaselinePayloadHasher,
  storedBaselinePayloadSource,
} from "./ProjectionBaselineRows.ts";
import { PROJECTION_BASELINE_TABLES } from "./ProjectionBaselineSchema.ts";
import type { BaselinePayloadRow, BaselinePayloadSource } from "./Services/ProjectionBaselines.ts";

const TURNS_TABLE = "projection_turns";
const STAGED_TABLE = "temp.projection_baseline_turn_rewrite_staged";
const SORTED_TABLE = "temp.projection_baseline_turn_rewrite_sorted";

export type BaselineTurnRewriteOutcome = "unchanged" | "rewritten" | "corrupt";

const dropTempTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${STAGED_TABLE}`);
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${SORTED_TABLE}`);
  });

/**
 * Stages `rewritePage` of every stored turn row of the baseline, page by page. Returns whether
 * any row text changed.
 */
const stageRewrittenRows = <E, R>(
  sql: SqlClient.SqlClient,
  baselineId: number,
  rewritePage: (
    rows: ReadonlyArray<BaselinePayloadRow>,
  ) => Effect.Effect<ReadonlyArray<string>, E, R>,
) =>
  Effect.gen(function* () {
    let changed = false;
    yield* forEachBaselinePayloadPage(
      storedBaselinePayloadSource(sql, baselineId, null),
      TURNS_TABLE,
      (rows) =>
        Effect.gen(function* () {
          const rewritten = yield* rewritePage(rows);
          if (rewritten.length !== rows.length) {
            return yield* Effect.die(new Error("baseline turn rewrite must keep every row"));
          }
          changed ||= rewritten.some((rowJson, index) => rowJson !== rows[index]!.rowJson);
          yield* sql.unsafe(
            `INSERT INTO ${STAGED_TABLE} (row_json) VALUES ${rewritten.map(() => "(?)").join(", ")}`,
            rewritten,
          );
        }),
    );
    return changed;
  });

/**
 * One bounded pass over the baseline that returns its current hash (to check the stored rows
 * are intact before replacing them) and its hash once the sorted staged turn rows replace the
 * stored ones. Every other table is read once and fed to both hashes.
 */
const hashBeforeAndAfter = (sql: SqlClient.SqlClient, baselineId: number) =>
  Effect.gen(function* () {
    const before = makeBaselinePayloadHasher();
    const after = makeBaselinePayloadHasher();
    const stored = storedBaselinePayloadSource(sql, baselineId, null);
    const sorted: BaselinePayloadSource = {
      payloadHash: null,
      readTablePage: (_table, afterOrdinal, limit) =>
        sql
          .unsafe<BaselinePayloadRow>(
            `SELECT ordinal, row_json AS "rowJson" FROM ${SORTED_TABLE}
             WHERE ordinal > ? ORDER BY ordinal LIMIT ?`,
            [afterOrdinal, limit],
          )
          .pipe(Effect.mapError(toPersistenceSqlError("ProjectionBaselineRows.turnRewrite"))),
    };
    for (const table of PROJECTION_BASELINE_TABLES) {
      before.beginTable(table);
      after.beginTable(table);
      if (table === TURNS_TABLE) {
        yield* forEachBaselinePayloadPage(stored, table, (rows) =>
          Effect.sync(() => rows.forEach((row) => before.row(row.rowJson))),
        );
        yield* forEachBaselinePayloadPage(sorted, table, (rows) =>
          Effect.sync(() => rows.forEach((row) => after.row(row.rowJson))),
        );
      } else {
        yield* forEachBaselinePayloadPage(stored, table, (rows) =>
          Effect.sync(() =>
            rows.forEach((row) => {
              before.row(row.rowJson);
              after.row(row.rowJson);
            }),
          ),
        );
      }
      before.endTable();
      after.endTable();
    }
    return { before: before.digest(), after: after.digest() };
  });

/**
 * Replaces the baseline's stored turn rows with `rewritePage` of each, re-sorted by their new
 * text exactly as capture orders rows, and rehashes the baseline. Rows are only ever handled
 * one page (`BASELINE_PAYLOAD_PAGE_ROWS`, 500) at a time; SQLite sorts the staged rows itself.
 *
 * - `unchanged`: no row text changed, so nothing is written (the stored order and hash stand).
 * - `corrupt`: the stored rows no longer match `payloadHash`; nothing is written, so restoring
 *   the baseline still fails on that hash and the rows are never blessed with a new one.
 * - `rewritten`: rows and `payload_hash` were replaced.
 *
 * Run inside the caller's transaction (migrations are).
 */
export const rewriteBaselineTurnRows = <E, R>(
  sql: SqlClient.SqlClient,
  baseline: { readonly baselineId: number; readonly payloadHash: string },
  rewritePage: (
    rows: ReadonlyArray<BaselinePayloadRow>,
  ) => Effect.Effect<ReadonlyArray<string>, E, R>,
) =>
  Effect.gen(function* () {
    const { baselineId } = baseline;
    yield* dropTempTables(sql);
    yield* sql.unsafe(`CREATE TEMP TABLE projection_baseline_turn_rewrite_staged (
      row_json TEXT NOT NULL)`);
    yield* sql.unsafe(`CREATE TEMP TABLE projection_baseline_turn_rewrite_sorted (
      ordinal INTEGER PRIMARY KEY, row_json TEXT NOT NULL)`);
    const outcome = yield* Effect.gen(function* () {
      if (!(yield* stageRewrittenRows(sql, baselineId, rewritePage))) {
        return "unchanged" as const;
      }
      yield* sql.unsafe(
        `INSERT INTO ${SORTED_TABLE} (ordinal, row_json)
         SELECT row_number() OVER (ORDER BY row_json) - 1, row_json FROM ${STAGED_TABLE}`,
      );
      const hashes = yield* hashBeforeAndAfter(sql, baselineId);
      if (hashes.before !== baseline.payloadHash) return "corrupt" as const;
      yield* sql.unsafe(
        "DELETE FROM projection_baseline_rows WHERE baseline_id = ? AND table_name = ?",
        [baselineId, TURNS_TABLE],
      );
      yield* sql.unsafe(
        `INSERT INTO projection_baseline_rows (baseline_id, table_name, ordinal, row_json)
         SELECT ?, ?, ordinal, row_json FROM ${SORTED_TABLE}`,
        [baselineId, TURNS_TABLE],
      );
      yield* sql.unsafe("UPDATE projection_baselines SET payload_hash = ? WHERE baseline_id = ?", [
        hashes.after,
        baselineId,
      ]);
      return "rewritten" as const;
    });
    yield* dropTempTables(sql);
    if (outcome === "corrupt") {
      yield* Effect.logWarning("projection baseline rows do not match their hash; not rewritten", {
        baselineId,
      });
    }
    return outcome satisfies BaselineTurnRewriteOutcome;
  });
