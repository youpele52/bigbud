import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_delegations (
      delegation_id TEXT PRIMARY KEY,
      caller_thread_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      parent_delegation_id TEXT,
      root_delegation_id TEXT NOT NULL,
      depth INTEGER NOT NULL,
      target_kind TEXT NOT NULL,
      target_project_id TEXT,
      target_canonical_workspace TEXT,
      child_thread_id TEXT NOT NULL UNIQUE,
      child_turn_id TEXT NOT NULL,
      created_project_id TEXT,
      state TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (caller_thread_id, source_message_id, invocation_id)
    )
  `;
});
