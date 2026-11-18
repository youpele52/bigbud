import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * P8 worker peer endpoint (M6 WP-8B). `peer_children` is worker-side: one row per delegated
 * child, keyed by the coordinator-namespaced command id (`peer:<coordinator>:<dispatch>`). It
 * records which grant created which child, so status, follow and cancel only reach children
 * created under the caller's grant, and fixes the child's creation time so a repeated delegate
 * dispatches byte-identical orchestration commands that command receipts deduplicate.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS peer_children (
    command_id TEXT PRIMARY KEY,
    dispatch_id TEXT NOT NULL,
    coordinator_authority_id TEXT NOT NULL CHECK(length(coordinator_authority_id) = 32),
    grant_id TEXT NOT NULL,
    child_thread_id TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
    workspace_root TEXT NOT NULL,
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL,
    cancel_requested_at TEXT,
    CHECK(command_id = 'peer:' || coordinator_authority_id || ':' || dispatch_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS peer_children_grant
    ON peer_children(grant_id, created_at)`;
});
