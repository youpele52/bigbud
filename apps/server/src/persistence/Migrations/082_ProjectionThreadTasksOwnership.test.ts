import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("082_ProjectionThreadTasksOwnership", (it) => {
  it.effect("cleans historic orphans and cascades only tasks owned by the deleted parent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          ('delete-parent', 'project', 'Delete', '{}', 'full-access', 'default', 'now', 'now'),
          ('keep-parent', 'project', 'Keep', '{}', 'full-access', 'default', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
        VALUES
          ('delete-task', 'delete-parent', '{}', 'now', 'now'),
          ('keep-task', 'keep-parent', '{}', 'now', 'now'),
          ('orphan-task', 'missing-parent', '{}', 'now', 'now')
      `;
      yield* sql`CREATE TABLE projection_thread_task_audit (task_id TEXT NOT NULL)`;
      yield* sql`
        CREATE TRIGGER projection_thread_tasks_audit_update
        AFTER UPDATE OF task_json ON projection_thread_tasks
        BEGIN
          INSERT INTO projection_thread_task_audit (task_id) VALUES (NEW.task_id);
        END
      `;

      yield* runMigrations();

      assert.deepEqual(
        yield* sql<{ readonly name: string; readonly type: string }>`
          SELECT name, type FROM sqlite_master
          WHERE (type = 'index' AND name = 'idx_projection_thread_tasks_thread_order')
             OR (type = 'trigger' AND name = 'projection_thread_tasks_audit_update')
          ORDER BY type, name
        `,
        [
          { name: "idx_projection_thread_tasks_thread_order", type: "index" },
          { name: "projection_thread_tasks_audit_update", type: "trigger" },
        ],
      );
      assert.deepEqual(
        yield* sql<{ readonly name: string; readonly type: string; readonly notnull: number }>`
          SELECT name, type, "notnull" FROM pragma_table_info('projection_thread_tasks')
        `,
        [
          { name: "task_id", type: "TEXT", notnull: 0 },
          { name: "thread_id", type: "TEXT", notnull: 1 },
          { name: "task_json", type: "TEXT", notnull: 1 },
          { name: "created_at", type: "TEXT", notnull: 1 },
          { name: "updated_at", type: "TEXT", notnull: 1 },
        ],
      );
      assert.deepEqual(
        yield* sql`
          SELECT "table", "from", "to", on_delete
          FROM pragma_foreign_key_list('projection_thread_tasks')
        `,
        [{ table: "projection_threads", from: "thread_id", to: "thread_id", on_delete: "CASCADE" }],
      );
      assert.deepEqual(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM projection_thread_tasks WHERE task_id = 'orphan-task'
        `,
        [{ count: 0 }],
      );

      yield* sql`
        UPDATE projection_thread_tasks SET task_json = '{"updated":true}'
        WHERE task_id = 'keep-task'
      `;
      assert.deepEqual(yield* sql`SELECT task_id FROM projection_thread_task_audit`, [
        { task_id: "keep-task" },
      ]);
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'delete-parent'`;
      assert.deepEqual(yield* sql`SELECT task_id FROM projection_thread_tasks ORDER BY task_id`, [
        { task_id: "keep-task" },
      ]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});
