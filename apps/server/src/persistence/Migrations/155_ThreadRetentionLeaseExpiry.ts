import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Thread retention counts only real work, so leases must be able to end without their holder.
 *
 * - `expires_at` on both lease tables. Holders' rows are renewed by the lease heartbeat while
 *   their process (or, for terminals and shells, their PID) is alive; the bounded lease sweep
 *   removes the rest. Migrations run before any holder starts, so every existing terminal,
 *   shell, browser and computer-use lease belongs to a previous process and starts expired.
 *   Provider leases follow their runtime row, and learning leases are cleanup fences swept by
 *   job age, so neither gets an expiry.
 * - `deferred_canonical_cleanup_retries`: backoff and last failure for the bounded automatic
 *   retry of deletions whose canonical history cleanup was deferred. A row exists only while a
 *   retry has failed; success removes the deletion marker and this row with it.
 * - An index on `orchestration_event_ids(sequence)`. Canonical cleanup deletes a thread's event
 *   IDs by sequence, which otherwise scans the whole table (about 200 ms per deletion on a
 *   4-million-row log), and the automatic retry runs that cleanup in the background. Building
 *   it takes about 1.5 seconds once on that log.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE worktree_runtime_leases ADD COLUMN expires_at TEXT`;
  yield* sql`ALTER TABLE thread_activity_leases ADD COLUMN expires_at TEXT`;
  yield* sql`
    UPDATE worktree_runtime_leases SET expires_at = updated_at
    WHERE runtime_kind IN ('terminal', 'shell')
  `;
  yield* sql`
    UPDATE thread_activity_leases SET expires_at = acquired_at
    WHERE activity_kind IN ('browser', 'computer-use')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_event_ids_sequence
    ON orchestration_event_ids(sequence)
  `;
  yield* sql`
    CREATE TABLE deferred_canonical_cleanup_retries (
      thread_id TEXT PRIMARY KEY,
      deletion_sequence INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      last_error_code TEXT,
      last_error_detail TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
