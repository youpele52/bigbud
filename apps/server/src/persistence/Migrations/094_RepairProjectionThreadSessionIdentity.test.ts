import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "094_RepairProjectionThreadSessionIdentity - current schema",
  (it) => {
    it.effect("keeps session identity columns on a current schema", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 94 });
        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_thread_sessions)
        `;
        assert.ok(columns.some((column) => column.name === "provider_session_id"));
        assert.ok(columns.some((column) => column.name === "provider_thread_id"));
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "094_RepairProjectionThreadSessionIdentity - broken 081 schema",
  (it) => {
    it.effect("restores session identity columns dropped by a recorded 081 rebuild", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 93 });
        yield* sql.unsafe(`
          CREATE TABLE projection_thread_sessions_broken (
            thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            provider_name TEXT,
            runtime_mode TEXT,
            active_turn_id TEXT,
            reason TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL
          )
        `);
        yield* sql.unsafe(`
          INSERT INTO projection_thread_sessions_broken
            (thread_id, status, provider_name, runtime_mode, active_turn_id, reason, last_error, updated_at)
          SELECT thread_id, status, provider_name, runtime_mode, active_turn_id, reason, last_error, updated_at
          FROM projection_thread_sessions
        `);
        yield* sql.unsafe("DROP TABLE projection_thread_sessions");
        yield* sql.unsafe(
          "ALTER TABLE projection_thread_sessions_broken RENAME TO projection_thread_sessions",
        );
        yield* runMigrations();
        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_thread_sessions)
        `;
        assert.ok(columns.some((column) => column.name === "provider_session_id"));
        assert.ok(columns.some((column) => column.name === "provider_thread_id"));
      }),
    );
  },
);
