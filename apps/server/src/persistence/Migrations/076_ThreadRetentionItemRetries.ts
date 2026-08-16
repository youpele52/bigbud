import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE thread_retention_run_items ADD COLUMN next_attempt_at TEXT`;
  yield* sql`
    CREATE INDEX idx_thread_retention_items_retry
    ON thread_retention_run_items(next_attempt_at, run_id, thread_id)
    WHERE next_attempt_at IS NOT NULL
  `;
});
