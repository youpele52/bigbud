import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./051_PurgeJobs.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_PurgeJobs", (it) => {
  it.effect("creates the durable purge-job schema and resume indexes idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* migration;
      yield* migration;

      const columns = yield* sql<{
        readonly name: string;
        readonly notNull: number;
        readonly primaryKey: number;
      }>`
        SELECT name, "notnull" AS "notNull", pk AS "primaryKey"
        FROM pragma_table_info('purge_jobs')
        ORDER BY cid
      `;
      assert.deepEqual(columns, [
        { name: "job_id", notNull: 0, primaryKey: 1 },
        { name: "entity_kind", notNull: 1, primaryKey: 0 },
        { name: "entity_id", notNull: 1, primaryKey: 0 },
        { name: "phase", notNull: 1, primaryKey: 0 },
        { name: "status", notNull: 1, primaryKey: 0 },
        { name: "resource_manifest_json", notNull: 1, primaryKey: 0 },
        { name: "attempt_count", notNull: 1, primaryKey: 0 },
        { name: "last_error", notNull: 0, primaryKey: 0 },
        { name: "created_at", notNull: 1, primaryKey: 0 },
        { name: "updated_at", notNull: 1, primaryKey: 0 },
        { name: "completed_at", notNull: 0, primaryKey: 0 },
      ]);

      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_master
        WHERE name IN ('idx_purge_jobs_incomplete_entity', 'idx_purge_jobs_resume')
        ORDER BY name
      `;
      assert.equal(indexes.length, 2);
      assert.match(
        indexes.find((index) => index.name === "idx_purge_jobs_incomplete_entity")?.sql ?? "",
        /entity_kind, entity_id\)\s+WHERE status <> 'completed'/,
      );
      assert.match(
        indexes.find((index) => index.name === "idx_purge_jobs_resume")?.sql ?? "",
        /status, updated_at, job_id/,
      );
    }),
  );
});
