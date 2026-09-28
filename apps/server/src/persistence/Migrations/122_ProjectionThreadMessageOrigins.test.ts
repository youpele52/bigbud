import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("122_ProjectionThreadMessageOrigins", (it) => {
  it.effect("adds nullable durable origin segments without changing legacy rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 121 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project', 'Project', '/project', '[]', '2026-01-01', '2026-01-01')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES ('thread', 'project', 'Thread',
          '{"provider":"codex","model":"test"}', 'full-access', 'default',
          '2026-01-01', '2026-01-01')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('message', 'thread', 'user', 'Legacy', 0, '2026-01-01', '2026-01-01')
      `;
      yield* runMigrations();
      const rows = yield* sql<{ readonly origin: string | null }>`
        SELECT origin_segments_json AS origin FROM projection_thread_messages
      `;
      assert.deepEqual(rows, [{ origin: null }]);
    }),
  );
});
