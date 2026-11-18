import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { latestMigrationId, migrationEntries, runMigrations } from "./Migrations.ts";
import {
  DatabaseSchemaNewerThanRuntimeError,
  assertDatabaseSchemaNotNewer,
} from "./Migrations.downgradeGuard.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const createMigrationsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE effect_sql_migrations (
    migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`;
  return sql;
});

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    assert.isTrue(Exit.isFailure(exit));
    return Exit.isFailure(exit) ? exit.cause : undefined;
  });

it.effect("newer_schema_refuses_startup", () =>
  Effect.gen(function* () {
    const sql = yield* createMigrationsTable;
    const future = latestMigrationId + 1;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'OrchestrationEvents')`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${future}, 'FutureSchema')`;
    const error = yield* Effect.flip(runMigrations());
    assert.instanceOf(error, DatabaseSchemaNewerThanRuntimeError);
    assert.strictEqual(error._tag, "DatabaseSchemaNewerThanRuntimeError");
    assert.strictEqual(error.appliedMigrationId, future);
    assert.strictEqual(error.appliedMigrationName, "FutureSchema");
    assert.strictEqual(error.latestKnownMigrationId, latestMigrationId);
    assert.include(error.message, `migration ${future}_FutureSchema is applied`);
    assert.include(error.message, `only knows migrations up to ${latestMigrationId}`);
    // The refusal happens before the migrator runs: no other migration is recorded or created.
    const rows = yield* sql<{ readonly id: number }>`
      SELECT migration_id AS "id" FROM effect_sql_migrations ORDER BY migration_id
    `;
    assert.deepEqual(
      rows.map((row) => row.id),
      [1, future],
    );
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_events'
    `;
    assert.deepEqual(tables, []);
    // The progress-reporting startup path refuses the same way.
    assert.isDefined(yield* failureOf(runMigrations({ onProgress: () => undefined })));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("a fresh database and a database at this build's schema pass the guard", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* assertDatabaseSchemaNotNewer(latestMigrationId), 0);
    const sql = yield* createMigrationsTable;
    assert.strictEqual(yield* assertDatabaseSchemaNotNewer(latestMigrationId), 0);
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${latestMigrationId}, 'Latest')`;
    assert.strictEqual(yield* assertDatabaseSchemaNotNewer(latestMigrationId), latestMigrationId);
    // A build that knows one migration fewer refuses the same database.
    const error = yield* Effect.flip(assertDatabaseSchemaNotNewer(latestMigrationId - 1));
    assert.instanceOf(error, DatabaseSchemaNewerThanRuntimeError);
    assert.strictEqual(error.appliedMigrationId, latestMigrationId);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "same and older schemas start normally",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const older = migrationEntries[20]![0];
      const first = yield* runMigrations({ toMigrationInclusive: older });
      assert.strictEqual(first.at(-1)?.[0], older);
      // Older schema: the current build upgrades it.
      const upgraded = yield* runMigrations();
      assert.strictEqual(upgraded.at(-1)?.[0], latestMigrationId);
      // Same schema: a restart runs nothing and does not refuse.
      assert.deepEqual(yield* runMigrations(), []);
      const rows = yield* sql<{ readonly id: number }>`
        SELECT MAX(migration_id) AS "id" FROM effect_sql_migrations
      `;
      assert.strictEqual(rows[0]?.id, latestMigrationId);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  120_000,
);
