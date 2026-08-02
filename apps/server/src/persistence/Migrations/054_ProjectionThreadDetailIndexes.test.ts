import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./054_ProjectionThreadDetailIndexes.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_ProjectionThreadDetailIndexes", (it) => {
  it.effect("creates stable bounded-detail indexes idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* migration;
      yield* migration;

      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_master
        WHERE name LIKE 'idx_projection_%_stable'
           OR name = 'idx_projection_thread_activities_thread_turn_sequence'
           OR name = 'idx_projection_pending_approvals_thread_status_created'
        ORDER BY name
      `;
      assert.equal(indexes.length, 4);
      assert.match(
        indexes.find((index) => index.name.includes("messages"))?.sql ?? "",
        /thread_id, created_at DESC, message_id ASC/,
      );
      assert.match(
        indexes.find((index) => index.name.includes("activities"))?.sql ?? "",
        /thread_id, turn_id, sequence DESC, activity_id ASC/,
      );
      assert.match(
        indexes.find((index) => index.name.includes("approvals"))?.sql ?? "",
        /thread_id, status, created_at ASC, request_id ASC/,
      );
      assert.match(
        indexes.find((index) => index.name.includes("checkpoint"))?.sql ?? "",
        /checkpoint_turn_count DESC, turn_id ASC/,
      );
    }),
  );
});
