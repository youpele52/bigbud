import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./061_ProjectionChatsCreatedIndex.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_ProjectionChatsCreatedIndex", (it) => {
  it.effect("adds the active project creation-order index idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* migration;

      const indexes = yield* sql<{ readonly sql: string | null }>`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_threads_active_project_created'
      `;
      assert.equal(indexes.length, 1);
      assert.match(indexes[0]?.sql ?? "", /project_id, created_at DESC, thread_id DESC/);
      assert.match(indexes[0]?.sql ?? "", /deleting_at IS NULL/);
    }),
  );
});
