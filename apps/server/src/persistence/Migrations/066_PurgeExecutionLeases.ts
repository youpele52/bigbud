import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE purge_jobs ADD COLUMN execution_lease_id TEXT`;
  yield* sql`ALTER TABLE purge_jobs ADD COLUMN execution_lease_expires_at TEXT`;
  yield* sql`
    CREATE INDEX idx_purge_jobs_execution_lease
    ON purge_jobs(execution_lease_expires_at)
    WHERE status <> 'completed'
  `;
});
