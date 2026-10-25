import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("128_ProjectionThreadsForkOrigin", (it) => {
  it.effect("adds nullable fork lineage columns without changing existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 127 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project', 'Project', '/project', '[]', '2026-01-01', '2026-01-01')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, parent_thread_id, parent_thread_title, created_at, updated_at
        ) VALUES ('thread', 'project', 'Thread',
          '{"provider":"codex","model":"test"}', 'full-access', 'default',
          NULL, NULL, '2026-01-01', '2026-01-01')
      `;
      const executed = yield* runMigrations({ toMigrationInclusive: 128 });
      assert.deepEqual(
        executed.map(([id, name]) => `${id}_${name}`),
        ["128_ProjectionThreadsForkOrigin"],
      );
      const rows = yield* sql<{
        readonly title: string;
        readonly point: string | null;
        readonly reason: string | null;
        readonly failure: string | null;
      }>`
        SELECT title, fork_point_message_id AS point, fork_reason AS reason,
          fork_failure_event_id AS failure
        FROM projection_threads
      `;
      assert.deepEqual(rows, [{ title: "Thread", point: null, reason: null, failure: null }]);
      const rejected = yield* Effect.exit(
        sql`UPDATE projection_threads SET fork_reason = 'because' WHERE thread_id = 'thread'`,
      );
      assert.isTrue(rejected._tag === "Failure");
    }),
  );
});
