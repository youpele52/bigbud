import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Do not rebuild purge_jobs here: purge_resource_claims and checkpoint tables
  // retain foreign keys to it on upgraded databases.
  yield* sql`
    ALTER TABLE purge_jobs
    ADD COLUMN auto_resume_disabled INTEGER NOT NULL DEFAULT 0
      CHECK (auto_resume_disabled IN (0, 1))
  `;
  yield* sql`
    UPDATE purge_jobs
    SET auto_resume_disabled = 1,
      execution_lease_id = NULL,
      execution_lease_expires_at = NULL
    WHERE last_error = 'manual_recovery_required'
  `;
  yield* sql`DROP INDEX idx_purge_jobs_incomplete_entity`;
  yield* sql`DROP INDEX idx_purge_jobs_resume`;
  yield* sql`DROP INDEX idx_purge_jobs_execution_lease`;
  yield* sql`
    CREATE UNIQUE INDEX idx_purge_jobs_incomplete_entity ON purge_jobs(entity_kind, entity_id)
    WHERE status <> 'completed' AND auto_resume_disabled = 0
  `;
  yield* sql`
    CREATE INDEX idx_purge_jobs_resume
    ON purge_jobs(auto_resume_disabled, status, updated_at, job_id)
  `;
  yield* sql`
    CREATE INDEX idx_purge_jobs_execution_lease ON purge_jobs(execution_lease_expires_at)
    WHERE status <> 'completed' AND auto_resume_disabled = 0
  `;
});
