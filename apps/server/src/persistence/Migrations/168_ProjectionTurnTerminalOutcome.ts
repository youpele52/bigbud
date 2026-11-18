import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_turns)`;
  // Legacy completed rows may have been inferred from messages or checkpoints. Do not backfill.
  if (!columns.some((column) => column.name === "terminal_outcome")) {
    yield* sql`ALTER TABLE projection_turns ADD COLUMN terminal_outcome TEXT`;
  }
  if (!columns.some((column) => column.name === "checkpoint_completed_at")) {
    yield* sql`ALTER TABLE projection_turns ADD COLUMN checkpoint_completed_at TEXT`;
    // Preserve checkpoint history, without promoting legacy rows to native settlement proof.
    yield* sql`UPDATE projection_turns SET checkpoint_completed_at = completed_at
      WHERE checkpoint_turn_count IS NOT NULL`;
  }
});
