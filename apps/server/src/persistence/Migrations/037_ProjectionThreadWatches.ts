import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_watches (
      watch_id TEXT PRIMARY KEY,
      watcher_thread_id TEXT NOT NULL,
      watched_thread_id TEXT NOT NULL,
      watched_thread_title TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      triggered_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_watches_watched_active
    ON projection_thread_watches(watched_thread_id, status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_watches_watcher_active
    ON projection_thread_watches(watcher_thread_id, status)
  `;
});
