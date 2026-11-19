import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0180 from "./180_TerminalActivity.ts";

const indexes = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'projection_threads' AND name LIKE '%_page'
    ORDER BY name`.pipe(Effect.map((rows) => rows.map((row) => row.name)));

it.effect("adds terminal recency, finished attention and the recency page indexes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 179 });
    yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at, deleted_at
      ) VALUES ('m-thread', 'p', 't', 'standard', '{"provider":"codex","model":"m"}',
        'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL)`;
    assert.deepEqual(yield* indexes(sql), [
      "idx_projection_threads_organization_activity_page",
      "idx_projection_threads_project_activity_page",
      "idx_projection_threads_project_created_page",
    ]);

    yield* runMigrations({ toMigrationInclusive: 180 });
    const [row] = yield* sql<{ readonly at: string | null }>`
      SELECT latest_terminal_activity_at AS at FROM projection_threads WHERE thread_id = 'm-thread'`;
    assert.isNull(row?.at ?? null);
    assert.deepEqual(yield* indexes(sql), [
      "idx_projection_threads_organization_recency_page",
      "idx_projection_threads_project_created_page",
      "idx_projection_threads_project_recency_page",
    ]);
    yield* sql`INSERT INTO terminal_finished_attention
      (thread_id, terminal_id, finished_at, command, exit_code, duration_ms, source)
      VALUES ('m-thread', 'default', '2026-01-02T00:00:00.000Z', 'make', 2, 61000, 'process-poll')`;

    // Re-running is a no-op: existing column, table rows and indexes are kept.
    yield* Migration0180;
    const [count] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM terminal_finished_attention`;
    assert.equal(count?.count, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
