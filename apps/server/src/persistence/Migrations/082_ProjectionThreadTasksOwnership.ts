import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* sql<SchemaArtifact>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'projection_thread_tasks'
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
    ORDER BY type, name
  `;
  yield* sql.unsafe(`DELETE FROM projection_thread_tasks WHERE NOT EXISTS (
    SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_thread_tasks.thread_id
  )`);
  yield* sql.unsafe(`
    CREATE TABLE projection_thread_tasks_next (
      task_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      task_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO projection_thread_tasks_next (task_id, thread_id, task_json, created_at, updated_at)
    SELECT task_id, thread_id, task_json, created_at, updated_at
    FROM projection_thread_tasks
  `);
  yield* sql.unsafe("DROP TABLE projection_thread_tasks");
  yield* sql.unsafe("ALTER TABLE projection_thread_tasks_next RENAME TO projection_thread_tasks");
  for (const artifact of artifacts) {
    if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
  }
});
