import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./058_RepairProjectionNotes.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("058_RepairProjectionNotes", (it) => {
  it.effect("restores a missing notes projection after its original migration was recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`DROP TABLE projection_notes`;

      yield* migration;
      yield* migration;

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_notes') ORDER BY cid
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        ["note_id", "project_id", "title", "content", "created_at", "updated_at"],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_projection_notes_project_updated'
      `;
      assert.deepEqual(indexes, [{ name: "idx_projection_notes_project_updated" }]);
    }),
  );
});
