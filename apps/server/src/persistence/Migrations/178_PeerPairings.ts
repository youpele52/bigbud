import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * P8 coordinator dispatch and pairing (M6 WP-8D/8E), coordinator side.
 *
 * - `peer_pairings`: the saved connection to one worker (SSH host, user, explicitly confirmed host
 *   key pin) plus the grant id the worker issued. Revoking clears the grant without deleting the
 *   connection; deleting the connection is a separate action.
 * - `peer_dispatch_requests`: the exact delegate request of each dispatch, so an uncertain send is
 *   re-sent byte-identically (the worker digests the request) and never rebuilt or relaunched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS peer_pairings (
    pairing_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    worker_authority_id TEXT NOT NULL UNIQUE CHECK(length(worker_authority_id) = 32),
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
    ssh_user TEXT NOT NULL,
    pinned_host_key TEXT NOT NULL,
    host_key_fingerprint TEXT NOT NULL,
    host_key_confirmed_at TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    provider TEXT NOT NULL,
    runtime_mode TEXT NOT NULL,
    coordinator_key_fingerprint TEXT NOT NULL,
    grant_id TEXT,
    grant_recorded_at TEXT,
    grant_revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((grant_id IS NULL) = (grant_recorded_at IS NULL)),
    CHECK(grant_revoked_at IS NULL OR grant_id IS NOT NULL)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS peer_dispatch_requests (
    dispatch_id TEXT PRIMARY KEY REFERENCES peer_dispatches(dispatch_id) ON DELETE CASCADE,
    request_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
});
