import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  baselinePageStatements,
  forEachBaselineTablePage,
  makeLatestVerifiedSequence,
} from "./ProjectionBaselines.queries.ts";

const VALID_HASH = "a".repeat(64);

/** Collects every page and records the largest one, so tests can assert pages stay bounded. */
const readBaselineTableRows = (sql: SqlClient.SqlClient, table: string, pageRows: number) =>
  Effect.gen(function* () {
    const rows: Array<Record<string, unknown>> = [];
    let largestPage = 0;
    yield* forEachBaselineTablePage(
      sql,
      table,
      (page) =>
        Effect.sync(() => {
          largestPage = Math.max(largestPage, page.length);
          rows.push(...page);
        }),
      pageRows,
    );
    return Object.assign(rows, { largestPage });
  });

const layer = it.layer(SqlitePersistenceMemory);

layer("projection baseline queries", (it) => {
  it.effect("pages a rowid table and returns exactly what one full read returns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE baseline_paging_probe (id TEXT PRIMARY KEY, body TEXT, n INTEGER)`;
      for (let index = 0; index < 23; index += 1) {
        yield* sql`INSERT INTO baseline_paging_probe (id, body, n)
          VALUES (${`row-${index}`}, ${"x".repeat(index)}, ${index})`;
      }
      // Gaps in rowid must not stop paging early.
      yield* sql`DELETE FROM baseline_paging_probe WHERE n IN (4, 5, 17)`;

      const full = yield* sql.unsafe<Record<string, unknown>>(
        "SELECT * FROM baseline_paging_probe ORDER BY rowid",
      );
      const paged = yield* readBaselineTableRows(sql, "baseline_paging_probe", 4);

      assert.equal(paged.length, 20);
      assert.equal(paged.largestPage, 4);
      assert.deepEqual([...paged], full);
      assert.isFalse(paged.some((row) => "__bigbud_baseline_rowid" in row));
    }),
  );

  it.effect("returns an empty table and an exact page boundary without extra rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE baseline_paging_boundary (id INTEGER PRIMARY KEY, v TEXT)`;
      assert.deepEqual([...(yield* readBaselineTableRows(sql, "baseline_paging_boundary", 3))], []);
      for (let index = 1; index <= 6; index += 1) {
        yield* sql`INSERT INTO baseline_paging_boundary (id, v) VALUES (${index}, ${`v${index}`})`;
      }
      const paged = yield* readBaselineTableRows(sql, "baseline_paging_boundary", 3);
      assert.deepEqual(
        paged.map((row) => row.id),
        [1, 2, 3, 4, 5, 6],
      );
    }),
  );

  it.effect("reads WITHOUT ROWID tables in one statement", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE baseline_paging_norowid (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`;
      yield* sql`INSERT INTO baseline_paging_norowid (k, v) VALUES ('b', '2'), ('a', '1')`;
      const rows = yield* readBaselineTableRows(sql, "baseline_paging_norowid", 1);
      assert.deepEqual(rows.map((row) => row.k).toSorted(), ["a", "b"]);
    }),
  );

  it.effect("seeks the rowid index for continuation pages instead of rescanning", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE baseline_paging_plan (id TEXT PRIMARY KEY, v TEXT)`;
      const { next } = baselinePageStatements("baseline_paging_plan");
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${next}`,
        [0, 10],
      );
      const details = plan.map((row) => row.detail).join(" | ");
      assert.match(details, /SEARCH .*rowid>\?/i);
      assert.notMatch(details, /\bSCAN baseline_paging_plan\b/);
    }),
  );

  it.effect("reads the newest verified sequence and ignores candidates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const latest = makeLatestVerifiedSequence(sql);
      assert.isTrue(Option.isNone(yield* latest()));

      const insert = (sequence: number, status: string) =>
        sql`INSERT INTO projection_baselines (sequence, format_version, payload_json, payload_hash,
            verification_status, created_at)
          VALUES (${sequence}, 2, '', ${VALID_HASH}, ${status},
            '2026-11-05T00:00:00.000Z')`;
      yield* insert(10, "verified");
      yield* insert(30, "verified");
      yield* insert(50, "candidate");

      assert.deepEqual(yield* latest(), Option.some(30));
    }),
  );

  it.effect("fails coverage for an unconverted or malformed verified baseline", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_baselines (sequence, format_version, payload_json,
          payload_hash, verification_status, created_at)
        VALUES (70, 1, '{"tables":{}}', ${VALID_HASH}, 'verified', '2026-11-05T00:00:00.000Z')`;
      assert.equal((yield* Effect.exit(makeLatestVerifiedSequence(sql)()))._tag, "Failure");

      yield* sql`INSERT INTO projection_baselines (sequence, format_version, payload_json,
          payload_hash, verification_status, created_at)
        VALUES (80, 2, '', 'not-a-hash', 'verified', '2026-11-05T00:00:00.000Z')`;
      assert.equal((yield* Effect.exit(makeLatestVerifiedSequence(sql)()))._tag, "Failure");
    }),
  );
});
