import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("085_ProjectionTurnsOwnership", (it) => {
  it.effect("cascades owned turns without treating source plans as ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 84 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          ('delete-parent', 'project', 'Delete', '{}', 'full-access', 'default', 'now', 'now'),
          ('keep-parent', 'project', 'Keep', '{}', 'full-access', 'default', 'now', 'now'),
          ('source-parent', 'project', 'Source', '{}', 'full-access', 'default', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_files_json,
          source_proposed_plan_thread_id, source_proposed_plan_id
        ) VALUES
          ('delete-parent', 'delete-turn', 'completed', 'now', '[]', 'source-parent', 'source-plan'),
          ('keep-parent', 'keep-turn', 'completed', 'now', '[]', NULL, NULL),
          ('missing-parent', 'orphan-turn', 'completed', 'now', '[]', NULL, NULL)
      `;

      yield* runMigrations();

      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND name = 'thread_retention_guard_source_plan_insert'
        `,
        [{ name: "thread_retention_guard_source_plan_insert" }],
      );

      assert.deepEqual(
        yield* sql`SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('projection_turns')`,
        [{ table: "projection_threads", from: "thread_id", to: "thread_id", on_delete: "CASCADE" }],
      );
      assert.deepEqual(yield* sql`SELECT turn_id FROM projection_turns ORDER BY turn_id`, [
        { turn_id: "delete-turn" },
        { turn_id: "keep-turn" },
      ]);

      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'source-parent'`;
      assert.deepEqual(
        yield* sql`SELECT source_proposed_plan_thread_id FROM projection_turns WHERE turn_id = 'delete-turn'`,
        [{ source_proposed_plan_thread_id: "source-parent" }],
      );
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'delete-parent'`;
      assert.deepEqual(yield* sql`SELECT turn_id FROM projection_turns`, [
        { turn_id: "keep-turn" },
      ]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});
