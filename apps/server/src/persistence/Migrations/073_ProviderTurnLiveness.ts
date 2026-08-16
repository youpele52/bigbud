import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provider_turn_liveness (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      turn_started_at TEXT NOT NULL,
      last_runtime_event_at TEXT,
      last_meaningful_progress_at TEXT NOT NULL,
      last_inspection_at TEXT,
      inspection_status TEXT NOT NULL,
      consecutive_inspection_failures INTEGER NOT NULL DEFAULT 0,
      terminal_at TEXT,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_provider_turn_liveness_active_progress
    ON provider_turn_liveness(last_meaningful_progress_at, thread_id, turn_id)
    WHERE terminal_at IS NULL
  `;
});
