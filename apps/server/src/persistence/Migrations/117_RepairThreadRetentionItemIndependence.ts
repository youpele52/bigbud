import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { rebuildTableSql } from "./MigrationTableRebuild.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const foreignKeys = yield* sql<{ table: string }>`
    SELECT "table" FROM pragma_foreign_key_list('thread_retention_run_items')
  `;
  if (foreignKeys.some((key) => key.table === "projection_threads")) {
    // Run bookkeeping outlives thread projections, but is still owned by its run.
    yield* rebuildTableSql(
      sql,
      "thread_retention_run_items",
      () => `
      CREATE TABLE thread_retention_run_items (
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        expected_last_activity_at TEXT NOT NULL,
        deletion_command_id TEXT NOT NULL UNIQUE,
        purge_job_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('selected', 'deletion_requested', 'prepared', 'purging', 'completed', 'skipped', 'failed')),
        exclusion_reason TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        next_attempt_at TEXT,
        PRIMARY KEY (run_id, thread_id),
        FOREIGN KEY (run_id) REFERENCES thread_retention_runs(run_id) ON DELETE CASCADE
      )
    `,
    );
  }

  // The old cascade could erase outstanding items after dispatch, before their
  // outcome was recorded. Retain known totals and report the unknown remainder
  // as failures; never invent successful deletions or recreate deleted threads.
  yield* sql`
    WITH missing AS (
      SELECT run.run_id, run.selected_count - run.completed_count - run.skipped_count
        - run.failed_count - (
          SELECT COUNT(*) FROM thread_retention_run_items AS item
          WHERE item.run_id = run.run_id
            AND item.status IN ('selected', 'deletion_requested', 'prepared', 'purging')
        ) AS count
      FROM thread_retention_runs AS run
      WHERE run.status IN ('queued', 'selecting', 'preparing', 'purging', 'deferred')
    )
    UPDATE thread_retention_runs
    SET failed_count = failed_count + (SELECT count FROM missing WHERE missing.run_id = thread_retention_runs.run_id),
      last_error_code = 'retention_items_missing'
    WHERE run_id IN (SELECT run_id FROM missing WHERE count > 0)
  `;
});
