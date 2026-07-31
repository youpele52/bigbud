import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_ProjectionCatalogUserMessageIndex", (it) => {
  it.effect("adds a partial index for latest user-message catalog lookups", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_projection_thread_messages_latest_user'
      `;

      assert.deepEqual(indexes, [{ name: "idx_projection_thread_messages_latest_user" }]);
    }),
  );
});
