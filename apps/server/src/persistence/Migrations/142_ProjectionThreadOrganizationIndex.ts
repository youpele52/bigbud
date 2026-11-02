import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Serves Inyosira state pages: active threads of one organization state in `updated_at` order.
 * Creating it reads `projection_threads` once; it never touches messages or events.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_active_organization_state
    ON projection_threads(organization_state, updated_at DESC, thread_id ASC)
    WHERE deleted_at IS NULL AND archived_at IS NULL AND deleting_at IS NULL
  `;
});
