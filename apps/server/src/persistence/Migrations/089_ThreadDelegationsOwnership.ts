import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* sql<SchemaArtifact>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'thread_delegations'
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
      ORDER BY type, name
  `;
  yield* sql.unsafe(`DELETE FROM thread_delegations WHERE NOT EXISTS (
    SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = thread_delegations.caller_thread_id
  ) OR NOT EXISTS (
    SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = thread_delegations.child_thread_id
  )`);
  yield* sql.unsafe(`
    CREATE TABLE thread_delegations_next (
      delegation_id TEXT PRIMARY KEY,
      caller_thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      source_message_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      parent_delegation_id TEXT,
      root_delegation_id TEXT NOT NULL,
      depth INTEGER NOT NULL,
      target_kind TEXT NOT NULL,
      target_project_id TEXT,
      target_canonical_workspace TEXT,
      child_thread_id TEXT NOT NULL UNIQUE REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      child_turn_id TEXT NOT NULL,
      created_project_id TEXT,
      state TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (caller_thread_id, source_message_id, invocation_id)
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO thread_delegations_next (
      delegation_id, caller_thread_id, source_message_id, invocation_id, parent_delegation_id,
      root_delegation_id, depth, target_kind, target_project_id, target_canonical_workspace,
      child_thread_id, child_turn_id, created_project_id, state, result_json, error_json,
      created_at, updated_at
    )
    SELECT
      delegation_id, caller_thread_id, source_message_id, invocation_id, parent_delegation_id,
      root_delegation_id, depth, target_kind, target_project_id, target_canonical_workspace,
      child_thread_id, child_turn_id, created_project_id, state, result_json, error_json,
      created_at, updated_at
    FROM thread_delegations
  `);
  yield* sql.unsafe("DROP TABLE thread_delegations");
  yield* sql.unsafe("ALTER TABLE thread_delegations_next RENAME TO thread_delegations");
  for (const artifact of artifacts) {
    if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
  }
});
