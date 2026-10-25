import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Additive fork lineage for server-side forks (plan D19). The source stays in `parent_thread_*`,
 * so no foreign-key column is added; existing rows keep NULL. Never dropped.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN fork_point_message_id TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN fork_reason TEXT CHECK (
    fork_reason IS NULL OR fork_reason IN (
      'manual', 'session-dead', 'recovery-failed', 'provider-unavailable'
    )
  )`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN fork_failure_event_id TEXT`;
});
