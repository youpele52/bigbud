import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* sql<SchemaArtifact>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'projection_turns'
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
    ORDER BY name
  `;
  yield* sql.unsafe(`DELETE FROM projection_turns WHERE NOT EXISTS (
    SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_turns.thread_id
  )`);
  yield* sql.unsafe(`
    CREATE TABLE projection_turns_next (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT,
      pending_message_id TEXT,
      assistant_message_id TEXT,
      state TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT NOT NULL,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      UNIQUE (thread_id, turn_id),
      UNIQUE (thread_id, checkpoint_turn_count)
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO projection_turns_next (
      row_id, thread_id, turn_id, pending_message_id, assistant_message_id, state,
      requested_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
      checkpoint_status, checkpoint_files_json, source_proposed_plan_thread_id,
      source_proposed_plan_id
    )
    SELECT
      row_id, thread_id, turn_id, pending_message_id, assistant_message_id, state,
      requested_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
      checkpoint_status, checkpoint_files_json, source_proposed_plan_thread_id,
      source_proposed_plan_id
    FROM projection_turns
  `);
  yield* sql.unsafe("DROP TABLE projection_turns");
  yield* sql.unsafe("ALTER TABLE projection_turns_next RENAME TO projection_turns");
  for (const artifact of artifacts) {
    if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
  }
});
