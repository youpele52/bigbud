import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const livenessColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_turn_liveness)
  `;
  if (!livenessColumns.some((column) => column.name === "session_epoch")) {
    yield* sql`ALTER TABLE provider_turn_liveness
      ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0`;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "session_epoch")) {
    yield* sql`ALTER TABLE projection_thread_sessions
      ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0`;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "pending_turn_control_operation_json")) {
    yield* sql`ALTER TABLE projection_threads
      ADD COLUMN pending_turn_control_operation_json TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "queue_hold")) {
    yield* sql`ALTER TABLE projection_threads
      ADD COLUMN queue_hold INTEGER NOT NULL DEFAULT 0`;
  }
});
