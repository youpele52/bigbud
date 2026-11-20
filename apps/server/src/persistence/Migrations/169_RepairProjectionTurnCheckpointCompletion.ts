import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Forward repair for installations that already applied terminal-only migration 168. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_turns)`;
  if (columns.some((column) => column.name === "checkpoint_completed_at")) return;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN checkpoint_completed_at TEXT`;
  // Preserve checkpoint timestamps only. Never infer or rewrite native settlement evidence.
  yield* sql`UPDATE projection_turns SET checkpoint_completed_at = completed_at
    WHERE checkpoint_turn_count IS NOT NULL`;
});
