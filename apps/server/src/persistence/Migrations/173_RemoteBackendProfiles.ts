import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Persisted relay profile directory (WP-3A). One row per deployed remote backend authority,
 * pinning its authority key, installation, SSH host identity and the verified graph whose Node
 * binary and relay helper the laptop relay executes. Never stores tokens or credentials.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS remote_backend_profiles (
    profile_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    execution_target_id TEXT NOT NULL,
    label TEXT NOT NULL,
    authority_id TEXT NOT NULL UNIQUE CHECK(length(authority_id) = 32),
    key_fingerprint TEXT NOT NULL,
    key_epoch INTEGER NOT NULL CHECK(key_epoch >= 1),
    installation_fingerprint TEXT NOT NULL,
    host_identity TEXT NOT NULL,
    remote_home TEXT NOT NULL,
    graph_version TEXT NOT NULL,
    graph_target TEXT NOT NULL,
    graph_archive_sha256 TEXT NOT NULL CHECK(length(graph_archive_sha256) = 64),
    graph_manifest_sha256 TEXT NOT NULL CHECK(length(graph_manifest_sha256) = 64),
    graph_root TEXT NOT NULL,
    node_binary TEXT NOT NULL,
    node_sha256 TEXT NOT NULL CHECK(length(node_sha256) = 64),
    helper_entry TEXT NOT NULL,
    helper_sha256 TEXT NOT NULL CHECK(length(helper_sha256) = 64),
    boot_enabled INTEGER NOT NULL CHECK(boot_enabled IN (0, 1)),
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS remote_backend_profiles_target
    ON remote_backend_profiles(execution_target_id)`;
});
