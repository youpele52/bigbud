import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable Muse session-creation bindings. Separate from the provider
 * runtime directory so ProviderService startup rollback cannot erase the
 * only record of a native session bigbud asked Muse to create. No cascading
 * delete: removing a thread must not license creating a replacement session.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS muse_session_bindings (
    thread_id TEXT PRIMARY KEY,
    native_session_id TEXT NOT NULL,
    creation_command_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    storage_identity TEXT NOT NULL,
    selection_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('reserved', 'bound', 'blocked')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS muse_session_bindings_native
    ON muse_session_bindings(native_session_id)`;
});
