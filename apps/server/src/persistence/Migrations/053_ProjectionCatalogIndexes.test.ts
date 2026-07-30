import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./053_ProjectionCatalogIndexes.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ProjectionCatalogIndexes", (it) => {
  it.effect("backfills project recency and creates stable catalog indexes idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project', '/tmp/project', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'thread-1', 'project-1', 'Thread', 'standard',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z', NULL, NULL
        )
      `;

      yield* migration;
      yield* migration;

      const projects = yield* sql<{ readonly lastUsedAt: string }>`
        SELECT last_used_at AS "lastUsedAt" FROM projection_projects WHERE project_id = 'project-1'
      `;
      assert.equal(projects[0]?.lastUsedAt, "2026-01-03T00:00:00.000Z");

      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_master
        WHERE name IN (
          'idx_projection_projects_active_last_used',
          'idx_projection_threads_active_project_updated'
        )
        ORDER BY name
      `;
      assert.equal(indexes.length, 2);
      assert.match(indexes[0]?.sql ?? "", /last_used_at DESC, project_id ASC/);
      assert.match(indexes[1]?.sql ?? "", /project_id, updated_at DESC, thread_id ASC/);
    }),
  );
});
