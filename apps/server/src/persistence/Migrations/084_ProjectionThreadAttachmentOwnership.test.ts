import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("084_ProjectionThreadAttachmentOwnership", (it) => {
  it.effect("cascades references and preserves the lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          ('delete-parent', 'project', 'Delete', '{}', 'full-access', 'default', 'now', 'now'),
          ('keep-parent', 'project', 'Keep', '{}', 'full-access', 'default', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO projection_thread_attachment_refs
          (thread_id, attachment_id, source_kind, source_id, is_unresolved)
        VALUES
          ('delete-parent', 'delete-attachment', 'message', 'delete-message', 0),
          ('keep-parent', 'keep-attachment', 'message', 'keep-message', 0),
          ('missing-parent', 'orphan-attachment', 'message', 'orphan-message', 0)
        `;
      yield* sql`CREATE INDEX attachment_refs_custom ON projection_thread_attachment_refs(thread_id)`;

      yield* runMigrations();

      assert.deepEqual(
        yield* sql`
          SELECT "table", "from", "to", on_delete
          FROM pragma_foreign_key_list('projection_thread_attachment_refs')
        `,
        [{ table: "projection_threads", from: "thread_id", to: "thread_id", on_delete: "CASCADE" }],
      );
      assert.deepEqual(
        yield* sql`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name IN ('idx_projection_thread_attachment_refs_lookup', 'attachment_refs_custom')
          ORDER BY name
        `,
        [
          { name: "attachment_refs_custom" },
          { name: "idx_projection_thread_attachment_refs_lookup" },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT attachment_id FROM projection_thread_attachment_refs ORDER BY attachment_id`,
        [{ attachment_id: "delete-attachment" }, { attachment_id: "keep-attachment" }],
      );

      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'delete-parent'`;
      assert.deepEqual(yield* sql`SELECT attachment_id FROM projection_thread_attachment_refs`, [
        { attachment_id: "keep-attachment" },
      ]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});
