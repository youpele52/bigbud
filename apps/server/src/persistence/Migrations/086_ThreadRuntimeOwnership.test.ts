import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("086_ThreadRuntimeOwnership", (it) => {
  it.effect("cascades runtime state and checkpoint blobs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          ('delete-parent', 'project', 'Delete', '{}', 'full-access', 'default', 'now', 'now'),
          ('keep-parent', 'project', 'Keep', '{}', 'full-access', 'default', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, status, last_seen_at
        ) VALUES
          ('delete-parent', 'provider', 'adapter', 'stopped', 'now'),
          ('keep-parent', 'provider', 'adapter', 'stopped', 'now')
      `;
      yield* sql`
        INSERT INTO checkpoint_diff_blobs
          (thread_id, from_turn_count, to_turn_count, diff, created_at)
        VALUES
          ('delete-parent', 0, 1, 'delete', 'now'),
          ('keep-parent', 0, 1, 'keep', 'now')
      `;
      yield* sql`
        INSERT INTO provider_session_runtime
          (thread_id, provider_name, adapter_key, status, last_seen_at)
        VALUES ('missing-parent', 'provider', 'adapter', 'stopped', 'now')
      `;
      yield* sql`
        INSERT INTO checkpoint_diff_blobs
          (thread_id, from_turn_count, to_turn_count, diff, created_at)
        VALUES ('missing-parent', 1, 2, 'orphan', 'now')
      `;

      yield* runMigrations();
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND name IN (
            'thread_retention_guard_provider_runtime_insert',
            'thread_retention_guard_provider_runtime_update'
          )
          ORDER BY name
        `,
        [
          { name: "thread_retention_guard_provider_runtime_insert" },
          { name: "thread_retention_guard_provider_runtime_update" },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM provider_session_runtime ORDER BY thread_id`,
        [{ thread_id: "delete-parent" }, { thread_id: "keep-parent" }],
      );
      assert.deepEqual(yield* sql`SELECT thread_id FROM checkpoint_diff_blobs ORDER BY thread_id`, [
        { thread_id: "delete-parent" },
        { thread_id: "keep-parent" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('provider_session_runtime')`,
        [{ table: "projection_threads", from: "thread_id", to: "thread_id", on_delete: "CASCADE" }],
      );
      assert.deepEqual(
        yield* sql`SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('checkpoint_diff_blobs')`,
        [{ table: "projection_threads", from: "thread_id", to: "thread_id", on_delete: "CASCADE" }],
      );
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'delete-parent'`;
      assert.deepEqual(yield* sql`SELECT thread_id FROM provider_session_runtime`, [
        { thread_id: "keep-parent" },
      ]);
      assert.deepEqual(yield* sql`SELECT thread_id FROM checkpoint_diff_blobs`, [
        { thread_id: "keep-parent" },
      ]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});
