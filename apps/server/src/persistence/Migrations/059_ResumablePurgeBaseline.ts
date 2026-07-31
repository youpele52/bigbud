import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_purge_jobs_incomplete_entity`;
  yield* sql`DROP INDEX IF EXISTS idx_purge_jobs_resume`;
  yield* sql`
    CREATE TABLE purge_jobs_next (
      job_id TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('thread', 'project')),
      entity_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN (
        'awaiting-finalization', 'baseline', 'database', 'files', 'verifying', 'root'
      )),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'failed', 'completed')),
      resource_manifest_json TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO purge_jobs_next (
      job_id, entity_kind, entity_id, phase, status, resource_manifest_json,
      attempt_count, last_error, created_at, updated_at, completed_at
    )
    SELECT
      job_id, entity_kind, entity_id,
      CASE phase WHEN 'marking' THEN 'awaiting-finalization' ELSE phase END,
      status, resource_manifest_json, attempt_count, last_error, created_at, updated_at, completed_at
    FROM purge_jobs
  `;
  yield* sql`DROP TABLE purge_jobs`;
  yield* sql`ALTER TABLE purge_jobs_next RENAME TO purge_jobs`;
  yield* sql`
    CREATE UNIQUE INDEX idx_purge_jobs_incomplete_entity
    ON purge_jobs(entity_kind, entity_id)
    WHERE status <> 'completed'
  `;
  yield* sql`
    CREATE INDEX idx_purge_jobs_resume
    ON purge_jobs(status, updated_at, job_id)
  `;
});
