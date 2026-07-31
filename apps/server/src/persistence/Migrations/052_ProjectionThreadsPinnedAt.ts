import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "pinned_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pinned_at TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_active_pinned_at
    ON projection_threads(pinned_at DESC, thread_id ASC)
    WHERE pinned_at IS NOT NULL AND deleted_at IS NULL
  `;
});
