import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS purge_jobs (
      job_id TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('thread', 'project')),
      entity_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('marking', 'database', 'files', 'verifying', 'root')),
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_purge_jobs_incomplete_entity
    ON purge_jobs(entity_kind, entity_id)
    WHERE status <> 'completed'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_purge_jobs_resume
    ON purge_jobs(status, updated_at, job_id)
  `;
});
