import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./144_RetiredTerminalBackend.ts";

const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({ "144_RetiredTerminalBackend": migration }),
});

it.effect("reserves the retired migration without creating terminal backend resources", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* migrate, [[144, "RetiredTerminalBackend"]]);
    const tables = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
    assert.deepEqual(tables, [{ name: "effect_sql_migrations" }]);
    assert.deepEqual(yield* migrate, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("accepts the previously applied migration and preserves existing session data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE effect_sql_migrations (
      migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (144, 'HerdrTerminalOwners')`;
    yield* sql`CREATE TABLE herdr_terminal_owners (owner_key TEXT PRIMARY KEY, owner_json TEXT)`;
    yield* sql`INSERT INTO herdr_terminal_owners VALUES ('terminal', 'retained')`;
    assert.deepEqual(yield* migrate, []);
    const rows = yield* sql<{ owner_json: string }>`SELECT owner_json FROM herdr_terminal_owners`;
    assert.deepEqual(rows, [{ owner_json: "retained" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
