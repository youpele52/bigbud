import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { createRemoteExecutionTargetDisconnectsTable } from "../RemoteExecutionTargetDisconnects.schema.ts";
import migration from "./181_SshOwnerTransitions.ts";

const flags = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly target_id: string;
    readonly disconnected_at: number;
  }>`SELECT target_id, disconnected_at FROM remote_execution_target_disconnects ORDER BY target_id`;

it.effect(
  "adds only owner metadata to a pre-migration database and keeps legacy writes working",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 180 });
      yield* createRemoteExecutionTargetDisconnectsTable(sql);
      yield* sql`INSERT INTO remote_execution_target_disconnects VALUES ('ssh:legacy', 41)`;
      const schema =
        yield* sql`SELECT sql FROM sqlite_schema WHERE name = 'remote_execution_target_disconnects'`;
      const before = yield* flags(sql);

      yield* runMigrations({ toMigrationInclusive: 181 });
      assert.deepEqual(yield* flags(sql), before);
      assert.deepEqual(
        yield* sql`SELECT sql FROM sqlite_schema WHERE name = 'remote_execution_target_disconnects'`,
        schema,
      );
      assert.deepEqual(yield* sql`SELECT * FROM ssh_owner_writer`, []);
      assert.deepEqual(yield* sql`SELECT * FROM ssh_target_transition`, []);

      yield* sql`INSERT INTO remote_execution_target_disconnects VALUES ('ssh:next', 77)`;
      yield* sql`DELETE FROM remote_execution_target_disconnects WHERE target_id = 'ssh:legacy'`;
      yield* migration;
      assert.deepEqual(yield* flags(sql), [{ target_id: "ssh:next", disconnected_at: 77 }]);
      assert.deepEqual(yield* sql`SELECT * FROM ssh_owner_writer`, []);
      assert.deepEqual(yield* sql`SELECT * FROM ssh_target_transition`, []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("creates all three tables without inventing connection state on a fresh database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 181 });
    assert.deepEqual(yield* flags(sql), []);
    assert.deepEqual(yield* sql`SELECT * FROM ssh_owner_writer`, []);
    assert.deepEqual(yield* sql`SELECT * FROM ssh_target_transition`, []);
    assert.isTrue(yield* Effect.isFailure(sql`INSERT INTO ssh_owner_writer VALUES (2, 'epoch')`));
    assert.isTrue(
      yield* Effect.isFailure(
        sql`INSERT INTO ssh_target_transition VALUES ('ssh:new', 0, 'id', 'digest')`,
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
