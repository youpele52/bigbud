import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_usage_contributions (
      contribution_id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      used_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_output_tokens INTEGER NOT NULL,
      finalized INTEGER NOT NULL,
      source_sequence INTEGER,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_usage_contributions_occurred
    ON projection_usage_contributions(occurred_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_usage_contributions_thread_occurred
    ON projection_usage_contributions(thread_id, occurred_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_usage_contributions_provider_occurred
    ON projection_usage_contributions(provider, occurred_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_usage_backfill_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_activity_id TEXT NOT NULL,
      completed INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_usage_backfill_state (
      id,
      last_activity_id,
      completed,
      updated_at
    )
    VALUES (1, '', 0, ${new Date(0).toISOString()})
    ON CONFLICT (id) DO NOTHING
  `;
});
