import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("074_ThreadRetentionQueuedRuns", (it) => {
  it.effect("preserves an existing active run and prepares durable queued ordering", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      yield* sql`
        INSERT INTO thread_retention_runs (
          run_id, trigger_kind, policy, cutoff_at, status, active_slot, created_at, updated_at
        ) VALUES (
          'existing-active', 'manual', '30-days', '2026-07-01T00:00:00.000Z',
          'selecting', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations();

      const runs = yield* sql<{ runId: string; activeSlot: number | null; bypassUsed: number }>`
        SELECT run_id AS "runId", active_slot AS "activeSlot",
          queue_bypass_used AS "bypassUsed"
        FROM thread_retention_runs
      `;
      assert.deepEqual(runs, [{ runId: "existing-active", activeSlot: 1, bypassUsed: 0 }]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }),
  );
});
