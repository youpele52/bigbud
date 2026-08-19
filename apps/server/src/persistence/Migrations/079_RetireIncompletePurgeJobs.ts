import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `manual_recovery_required` is represented by a failed job with automatic
  // resume disabled; the legacy manifest remains available for recovery.
  yield* sql`
    UPDATE purge_jobs
    SET status = 'failed',
      last_error = 'manual_recovery_required',
      auto_resume_disabled = 1,
      execution_lease_id = NULL,
      execution_lease_expires_at = NULL
    WHERE status <> 'completed'
  `;
});
