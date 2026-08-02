import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./055_ProjectionPendingUserInputs.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_ProjectionPendingUserInputs", (it) => {
  it.effect("creates the durable pending-user-input table and bounded lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* migration;
      yield* migration;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_pending_user_inputs'
      `;
      assert.equal(tables.length, 1);
      const indexes = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master
        WHERE name = 'idx_projection_pending_user_inputs_thread_status_created'
      `;
      assert.match(indexes[0]?.sql ?? "", /thread_id, status, created_at ASC, request_id ASC/);
    }),
  );
});
