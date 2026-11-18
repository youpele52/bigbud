import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * P8 peer orchestration (M6 WP-8A).
 *
 * `peer_grants` is worker-side: at most one unrevoked grant per coordinator authority, so
 * re-pairing supersedes (revokes) the previous grant atomically.
 *
 * `peer_dispatches` is coordinator-side: one row per delegated child. The dispatch id, the
 * namespaced command id (`peer:<coordinator authority>:<dispatch id>`) and the coordinator
 * request key are each unique, so a retried delegation joins its existing row instead of
 * launching a second child. Cancel states require recorded cancel intent; accepted, following and
 * completed require a known child; completed requires a result and failed requires an error.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS peer_grants (
    grant_id TEXT PRIMARY KEY,
    coordinator_authority_id TEXT NOT NULL CHECK(length(coordinator_authority_id) = 32),
    coordinator_key_fingerprint TEXT NOT NULL
      CHECK(length(coordinator_key_fingerprint) = 71),
    worker_authority_id TEXT NOT NULL CHECK(length(worker_authority_id) = 32),
    actions_json TEXT NOT NULL,
    ceiling_json TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    CHECK(expires_at > issued_at)
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS peer_grants_active_coordinator
    ON peer_grants(coordinator_authority_id) WHERE revoked_at IS NULL`;

  yield* sql`CREATE TABLE IF NOT EXISTS peer_dispatches (
    dispatch_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    coordinator_authority_id TEXT NOT NULL CHECK(length(coordinator_authority_id) = 32),
    coordinator_thread_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    worker_authority_id TEXT NOT NULL CHECK(length(worker_authority_id) = 32),
    grant_id TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    provider TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'sent-uncertain', 'accepted', 'following',
      'completed', 'failed', 'cancel-pending', 'cancelled')),
    send_attempts INTEGER NOT NULL DEFAULT 0 CHECK(send_attempts >= 0),
    child_thread_id TEXT,
    cancel_requested_at TEXT,
    result_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(coordinator_thread_id, request_key),
    CHECK(command_id = 'peer:' || coordinator_authority_id || ':' || dispatch_id),
    CHECK(state NOT IN ('cancel-pending', 'cancelled') OR cancel_requested_at IS NOT NULL),
    CHECK(state NOT IN ('accepted', 'following', 'completed') OR child_thread_id IS NOT NULL),
    CHECK(state <> 'completed' OR result_json IS NOT NULL),
    CHECK(state <> 'failed' OR error_json IS NOT NULL),
    CHECK(state <> 'pending' OR send_attempts = 0)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS peer_dispatches_unsettled
    ON peer_dispatches(updated_at) WHERE state NOT IN ('completed', 'failed', 'cancelled')`;
  yield* sql`CREATE INDEX IF NOT EXISTS peer_dispatches_coordinator_thread
    ON peer_dispatches(coordinator_thread_id, created_at)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS peer_dispatches_child
    ON peer_dispatches(worker_authority_id, child_thread_id) WHERE child_thread_id IS NOT NULL`;
});
