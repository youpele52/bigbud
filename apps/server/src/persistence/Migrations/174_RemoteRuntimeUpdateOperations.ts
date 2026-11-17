import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Remote runtime update operations (M3 WP-4C, D9/D10). `live` is 1 for the single non-terminal
 * operation and NULL once it settles, so its UNIQUE constraint makes the update single-flight
 * across clients and restarts. Interruption consent is bound to the operation and the digest of
 * the affected-work list it named, and is consumed at most once.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS remote_runtime_update_operations (
    operation_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('release', 'laptop-upload', 'local-graph')),
    state TEXT NOT NULL CHECK(state IN ('pending', 'staging', 'staged', 'awaiting-drain',
      'deferred', 'activating', 'activated', 'failed', 'cancelled')),
    live INTEGER UNIQUE CHECK(live IS NULL OR live = 1),
    interrupt_requested INTEGER NOT NULL CHECK(interrupt_requested IN (0, 1)),
    archive_key TEXT,
    consent_state TEXT NOT NULL DEFAULT 'none'
      CHECK(consent_state IN ('none', 'recorded', 'consumed')),
    consent_digest TEXT CHECK(consent_digest IS NULL OR length(consent_digest) = 64),
    failure TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((live IS NOT NULL) = (state NOT IN ('activated', 'failed', 'cancelled')))
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS remote_runtime_update_operations_created
    ON remote_runtime_update_operations(created_at)`;
});
