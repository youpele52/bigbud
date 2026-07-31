import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("059_ResumablePurgeBaseline", (it) => {
  it.effect("migrates marking jobs to an explicit pre-finalization phase", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
          attempt_count, last_error, created_at, updated_at, completed_at
        ) VALUES (
          'purge-legacy', 'thread', 'thread-legacy', 'marking', 'failed', '[]',
          3, 'interrupted', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:01.000Z', NULL
        )
      `;

      yield* runMigrations();

      const rows = yield* sql<{ readonly phase: string; readonly attempts: number }>`
        SELECT phase, attempt_count AS attempts FROM purge_jobs WHERE job_id = 'purge-legacy'
      `;
      assert.deepEqual(rows, [{ phase: "awaiting-finalization", attempts: 3 }]);
      const rejected = yield* Effect.exit(
        sql`UPDATE purge_jobs SET phase = 'marking' WHERE job_id = 'purge-legacy'`,
      );
      assert.equal(rejected._tag, "Failure");
    }),
  );
});
