import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_active_project_created
    ON projection_threads(project_id, created_at DESC, thread_id DESC)
    WHERE deleted_at IS NULL AND archived_at IS NULL AND deleting_at IS NULL
  `;
});
