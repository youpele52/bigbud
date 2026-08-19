import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "095_RepairProjectionThreadProposedPlanImplementation - current schema",
  (it) => {
    it.effect("keeps proposed-plan implementation columns on a current schema", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 95 });
        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_thread_proposed_plans)
        `;
        assert.ok(columns.some((column) => column.name === "implemented_at"));
        assert.ok(columns.some((column) => column.name === "implementation_thread_id"));
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "095_RepairProjectionThreadProposedPlanImplementation - broken 083 schema",
  (it) => {
    it.effect("restores implementation columns dropped by a recorded 083 rebuild", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 94 });
        yield* sql.unsafe(`
          CREATE TABLE projection_thread_proposed_plans_broken (
            plan_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
            turn_id TEXT,
            plan_markdown TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `);
        yield* sql.unsafe(`
          INSERT INTO projection_thread_proposed_plans_broken
            (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at)
          SELECT plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at
          FROM projection_thread_proposed_plans
        `);
        yield* sql.unsafe("DROP TABLE projection_thread_proposed_plans");
        yield* sql.unsafe(
          "ALTER TABLE projection_thread_proposed_plans_broken RENAME TO projection_thread_proposed_plans",
        );
        yield* runMigrations();
        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_thread_proposed_plans)
        `;
        assert.ok(columns.some((column) => column.name === "implemented_at"));
        assert.ok(columns.some((column) => column.name === "implementation_thread_id"));
      }),
    );
  },
);
