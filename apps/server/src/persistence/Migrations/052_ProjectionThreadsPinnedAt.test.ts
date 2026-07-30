import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./052_ProjectionThreadsPinnedAt.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_ProjectionThreadsPinnedAt", (it) => {
  it.effect("adds the pin column and partial ordering index idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* migration;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(columns.filter((column) => column.name === "pinned_at").length, 1);

      const indexes = yield* sql<{
        readonly name: string;
        readonly sql: string | null;
      }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_threads_active_pinned_at'
      `;
      assert.equal(indexes.length, 1);
      assert.match(indexes[0]?.sql ?? "", /pinned_at DESC, thread_id ASC/);
      assert.match(indexes[0]?.sql ?? "", /pinned_at IS NOT NULL AND deleted_at IS NULL/);
    }),
  );
});
