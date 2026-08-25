import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const expectedColumns = [
  ["provider_turn_liveness", "session_epoch"],
  ["projection_thread_sessions", "session_epoch"],
  ["projection_threads", "pending_turn_control_operation_json"],
  ["projection_threads", "queue_hold"],
] as const;

const assertExpectedColumns = Effect.fn("assertExpectedColumns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, expectedColumn] of expectedColumns) {
    const columns = yield* sql.unsafe<{ readonly name: string }>(`PRAGMA table_info(${table})`);
    assert.ok(
      columns.some((column) => column.name === expectedColumn),
      `${table}.${expectedColumn} should exist`,
    );
  }
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "101_ProviderRuntimeEpochAndTurnControl - fresh schema",
  (it) => {
    it.effect("adds all runtime epoch and turn control columns", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* assertExpectedColumns();
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "101_ProviderRuntimeEpochAndTurnControl - partially applied 100",
  (it) => {
    it.effect("repairs columns added after migration 100 was recorded", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 99 });
        yield* sql`ALTER TABLE provider_turn_liveness
          ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (100, 'ProviderTurnLivenessSessionEpoch')`;

        yield* runMigrations();
        yield* assertExpectedColumns();
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "101_ProviderRuntimeEpochAndTurnControl - expanded 100",
  (it) => {
    it.effect("accepts databases that already contain every repaired column", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 99 });
        yield* sql`ALTER TABLE provider_turn_liveness
          ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0`;
        yield* sql`ALTER TABLE projection_thread_sessions
          ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0`;
        yield* sql`ALTER TABLE projection_threads
          ADD COLUMN pending_turn_control_operation_json TEXT`;
        yield* sql`ALTER TABLE projection_threads
          ADD COLUMN queue_hold INTEGER NOT NULL DEFAULT 0`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (100, 'ProviderTurnLivenessSessionEpoch')`;

        yield* runMigrations();
        yield* assertExpectedColumns();
      }),
    );
  },
);
