import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE thread_retention_runs
    ADD COLUMN queue_bypass_used INTEGER NOT NULL DEFAULT 0
      CHECK (queue_bypass_used IN (0, 1))
  `;
  yield* sql`
    CREATE INDEX idx_thread_retention_runs_queued
    ON thread_retention_runs(status, active_slot, trigger_kind, created_at, run_id)
    WHERE status = 'queued'
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_thread_retention_runs_pending_scheduled_policy
    ON thread_retention_runs(policy)
    WHERE trigger_kind = 'scheduled'
      AND status NOT IN ('completed', 'completed_with_failures', 'failed', 'cancelled')
  `;
});
