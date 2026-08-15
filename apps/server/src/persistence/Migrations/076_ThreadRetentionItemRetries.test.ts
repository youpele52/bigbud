import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("076_ThreadRetentionItemRetries", (it) => {
  it.effect("preserves retention items and adds durable retry scheduling", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* sql`
        INSERT INTO thread_retention_runs (
          run_id, trigger_kind, policy, cutoff_at, status, active_slot, created_at, updated_at
        ) VALUES (
          'retry-run', 'manual', '7-days', '2026-08-01T00:00:00.000Z',
          'preparing', 1, '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO thread_retention_run_items (
          run_id, thread_id, expected_last_activity_at, deletion_command_id,
          status, created_at, updated_at
        ) VALUES (
          'retry-run', 'retry-thread', '2026-08-01T00:00:00.000Z', 'retry-command',
          'deletion_requested', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'
        )
      `;

      yield* runMigrations();

      assert.deepEqual(
        yield* sql`
          SELECT run_id, thread_id, status, next_attempt_at
          FROM thread_retention_run_items
        `,
        [
          {
            run_id: "retry-run",
            thread_id: "retry-thread",
            status: "deletion_requested",
            next_attempt_at: null,
          },
        ],
      );
      yield* sql`
        UPDATE thread_retention_run_items
        SET next_attempt_at = '2026-08-04T00:30:00.000Z'
        WHERE run_id = 'retry-run' AND thread_id = 'retry-thread'
      `;
      assert.equal(
        (yield* sql<{ name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_thread_retention_items_retry'
          `)[0]?.name,
        "idx_thread_retention_items_retry",
      );
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }),
  );
});
