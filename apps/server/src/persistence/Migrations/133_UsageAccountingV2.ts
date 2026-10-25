import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_usage_contributions ADD COLUMN accounting_json TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN observable_token_count INTEGER`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN observable_estimator_version TEXT`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN usage_provider TEXT`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN usage_model TEXT`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN usage_interaction_mode TEXT`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN usage_attribution_source TEXT`;
  yield* sql`
    CREATE TABLE projection_usage_codex_state (
      thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      state_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE projection_usage_estimate_backfill_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_message_id TEXT NOT NULL,
      completed INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`INSERT INTO projection_usage_estimate_backfill_state
    VALUES (1, '', 0, ${new Date(0).toISOString()})`;
  yield* sql`CREATE INDEX idx_projection_usage_contributions_turn
    ON projection_usage_contributions(thread_id, turn_id)`;
  yield* sql`CREATE INDEX idx_projection_usage_messages_turn
    ON projection_thread_messages(thread_id, turn_id, role)`;
});
