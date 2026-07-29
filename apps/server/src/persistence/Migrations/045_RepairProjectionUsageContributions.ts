import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

function containsDuplicateColumnError(value: unknown): boolean {
  if (typeof value === "string") {
    return /duplicate column/i.test(value);
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const error = value as { readonly cause?: unknown; readonly message?: unknown };
  return containsDuplicateColumnError(error.message) || containsDuplicateColumnError(error.cause);
}

const ignoreDuplicateColumn = (error: SqlError) =>
  containsDuplicateColumnError(error) ? Effect.void : Effect.fail(error);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_usage_contributions
    ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown'
  `.pipe(Effect.catchTag("SqlError", ignoreDuplicateColumn));

  yield* sql`
    ALTER TABLE projection_usage_contributions
    ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default'
  `.pipe(Effect.catchTag("SqlError", ignoreDuplicateColumn));

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
