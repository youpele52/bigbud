import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_thread_identity WHERE NOT EXISTS (
    SELECT 1 FROM projection_threads
    WHERE projection_threads.thread_id = orchestration_thread_identity.thread_id
  )`;
  yield* sql.unsafe(`
    CREATE TABLE orchestration_thread_identity_next (
      thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      created_sequence INTEGER NOT NULL
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO orchestration_thread_identity_next (thread_id, project_id, created_sequence)
    SELECT thread_id, project_id, created_sequence FROM orchestration_thread_identity
  `);
  yield* sql`DROP TABLE orchestration_thread_identity`;
  yield* sql`ALTER TABLE orchestration_thread_identity_next RENAME TO orchestration_thread_identity`;
});
