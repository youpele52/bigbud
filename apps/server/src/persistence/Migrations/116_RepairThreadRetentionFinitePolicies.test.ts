import { describe } from "vitest";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration116 from "./116_RepairThreadRetentionFinitePolicies.ts";

const policyTables = [
  "thread_retention_consent_challenges",
  "thread_retention_policy_authority",
  "thread_retention_runs",
] as const;

const seedIntermediateSchema = Effect.fn("seedIntermediateSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of policyTables) {
    yield* sql.unsafe(`CREATE TABLE ${table} (
      run_id TEXT PRIMARY KEY,
      policy TEXT NOT NULL CHECK (policy IN (
        '1-day', '2-days', '7-days', '14-days', '30-days', '90-days'
        ${table === "thread_retention_policy_authority" ? ", 'never'" : ""}
      ))
    )`);
    yield* sql.unsafe(`INSERT INTO ${table} VALUES ('existing', '2-days')`);
  }
  yield* sql`CREATE TABLE thread_retention_run_items (
    run_id TEXT NOT NULL REFERENCES thread_retention_runs(run_id) ON DELETE CASCADE,
    thread_id TEXT PRIMARY KEY,
    status TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX retained_items_status ON thread_retention_run_items(status)`;
  yield* sql`CREATE TABLE thread_retention_failures (
    run_id TEXT NOT NULL REFERENCES thread_retention_runs(run_id) ON DELETE CASCADE,
    reason TEXT NOT NULL
  )`;
  yield* sql`CREATE TRIGGER retained_item_guard BEFORE UPDATE ON thread_retention_run_items
    BEGIN SELECT RAISE(ABORT, 'retained guard'); END`;
  yield* sql`CREATE TABLE retention_guard_source (thread_id TEXT)`;
  yield* sql`CREATE TRIGGER referencing_guard BEFORE INSERT ON retention_guard_source
    WHEN EXISTS (SELECT 1 FROM thread_retention_run_items WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'referencing guard'); END`;
  yield* sql`INSERT INTO thread_retention_run_items VALUES ('existing', 'thread', 'selected')`;
  yield* sql`INSERT INTO thread_retention_failures VALUES ('existing', 'preserved')`;
});

const verifyRepair = Effect.fn("verifyRepair")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of policyTables) {
    assert.deepEqual(yield* sql.unsafe(`SELECT * FROM ${table}`), [
      { run_id: "existing", policy: "2-days" },
    ]);
    yield* sql.unsafe(`INSERT INTO ${table} VALUES ('new', '3-days')`);
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(sql.unsafe(`INSERT INTO ${table} VALUES ('bad', '4-days')`)),
      ),
    );
  }
  yield* sql`INSERT INTO thread_retention_policy_authority VALUES ('disabled', 'never')`;
  assert.deepEqual(yield* sql`SELECT * FROM thread_retention_run_items`, [
    { run_id: "existing", thread_id: "thread", status: "selected" },
  ]);
  assert.deepEqual(yield* sql`SELECT * FROM thread_retention_failures`, [
    { run_id: "existing", reason: "preserved" },
  ]);
  assert.isTrue(
    Exit.isFailure(
      yield* Effect.exit(sql`UPDATE thread_retention_run_items SET status = 'failed'`),
    ),
  );
  assert.isTrue(
    Exit.isFailure(yield* Effect.exit(sql`INSERT INTO retention_guard_source VALUES ('thread')`)),
  );
  assert.equal((yield* sql`PRAGMA index_list(thread_retention_run_items)`).length, 2);
  assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name LIKE '%__097_%'`, []);
});

describe("116_RepairThreadRetentionFinitePolicies", () => {
  it.effect("repairs the intermediate schema while preserving rows, guards and indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedIntermediateSchema();
      yield* sql.withTransaction(Migration116);
      yield* sql.withTransaction(Migration116);
      yield* verifyRepair();
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("rolls back an interrupted migration and safely retries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedIntermediateSchema();
      const interrupted = sql.withTransaction(
        Migration116.pipe(Effect.andThen(Effect.fail(new Error("migration interrupted")))),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(interrupted)));
      for (const table of policyTables) {
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(sql.unsafe(`INSERT INTO ${table} VALUES ('new', '3-days')`)),
          ),
        );
      }
      assert.equal((yield* sql`SELECT * FROM thread_retention_run_items`).length, 1);
      yield* sql.withTransaction(Migration116);
      yield* verifyRepair();
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
