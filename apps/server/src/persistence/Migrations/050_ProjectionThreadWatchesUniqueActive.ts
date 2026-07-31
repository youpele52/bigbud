import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_thread_watches
    WHERE status = 'active'
      AND rowid NOT IN (
        SELECT MIN(rowid)
        FROM projection_thread_watches
        WHERE status = 'active'
        GROUP BY watcher_thread_id, source_message_id, watched_thread_id
      )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_projection_thread_watches_active_key
    ON projection_thread_watches(watcher_thread_id, source_message_id, watched_thread_id)
    WHERE status = 'active'
  `;
});
