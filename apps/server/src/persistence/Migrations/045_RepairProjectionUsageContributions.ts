import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_usage_contributions)
  `;

  if (!columns.some((column) => column.name === "model")) {
    yield* sql`
      ALTER TABLE projection_usage_contributions
      ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown'
    `;
  }

  if (!columns.some((column) => column.name === "interaction_mode")) {
    yield* sql`
      ALTER TABLE projection_usage_contributions
      ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default'
    `;
  }

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
