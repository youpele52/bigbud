import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Build A schema ceiling for the U5/U8 drain-on-quit record. The retirement
// record is the durable list of panes and pending items A drained; the marker
// is the one fact B may act on. The marker has a foreign key into the record so
// both rows can only be created in the same transaction. WAL is checkpointed
// after that commit and before the backend lock is released.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ssh_legacy_retirement (
      profile_scope TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('save-and-close', 'drain-now')),
      drained_leases TEXT NOT NULL,
      pending_items TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ssh_legacy_retired_marker (
      profile_scope TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      FOREIGN KEY (profile_scope) REFERENCES ssh_legacy_retirement (profile_scope)
    )
  `;
});
