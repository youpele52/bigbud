import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* sql<SchemaArtifact>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'projection_thread_watches'
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
      ORDER BY type, name
  `;
  yield* sql.unsafe(`DELETE FROM projection_thread_watches WHERE NOT EXISTS (
    SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_thread_watches.watcher_thread_id
  ) OR NOT EXISTS (
    SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_thread_watches.watched_thread_id
  )`);
  yield* sql.unsafe(`
    CREATE TABLE projection_thread_watches_next (
      watch_id TEXT PRIMARY KEY,
      watcher_thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      watched_thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      watched_thread_title TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      triggered_at TEXT
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO projection_thread_watches_next
      (watch_id, watcher_thread_id, watched_thread_id, watched_thread_title, source_message_id, status, created_at, triggered_at)
    SELECT watch_id, watcher_thread_id, watched_thread_id, watched_thread_title, source_message_id, status, created_at, triggered_at
    FROM projection_thread_watches
  `);
  yield* sql.unsafe("DROP TABLE projection_thread_watches");
  yield* sql.unsafe(
    "ALTER TABLE projection_thread_watches_next RENAME TO projection_thread_watches",
  );
  for (const artifact of artifacts) {
    if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
  }
});
