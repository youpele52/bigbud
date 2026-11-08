import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Background event-log maintenance (compaction and ledger pruning).
 *
 * - `event_log_maintenance_state`: one row of progress that survives restarts, so a backlog
 *   that keeps growing is still reported after one, and the read-only size report can show it.
 *   `receipts_through_sequence` is the ledger pruning cursor: receipts at or below it were either
 *   pruned or are kept on purpose (referenced by a recovery table).
 * - Drops `idx_orch_events_correlation_id` (about 540 MB on a 4-million-event log). Nothing
 *   queries events by `correlation_id`; the column is still written and read back.
 *
 * The index on `orchestration_event_ids(sequence)` that ledger pruning uses was added by
 * migration 155.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS event_log_maintenance_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      floor_sequence INTEGER NOT NULL DEFAULT 0,
      floor_held_by TEXT,
      backlog_sequences INTEGER NOT NULL DEFAULT 0,
      backlog_low_water INTEGER NOT NULL DEFAULT 0,
      backlog_low_water_at TEXT,
      starved INTEGER NOT NULL DEFAULT 0 CHECK (starved IN (0, 1)),
      starved_since TEXT,
      last_batch_at TEXT,
      longest_batch_ms REAL NOT NULL DEFAULT 0,
      rate_per_minute REAL NOT NULL DEFAULT 0,
      events_deleted INTEGER NOT NULL DEFAULT 0,
      gaps_deleted INTEGER NOT NULL DEFAULT 0,
      receipts_deleted INTEGER NOT NULL DEFAULT 0,
      claims_deleted INTEGER NOT NULL DEFAULT 0,
      event_ids_deleted INTEGER NOT NULL DEFAULT 0,
      receipts_through_sequence INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_error_at TEXT,
      backoff_until TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO event_log_maintenance_state (singleton_id, updated_at)
    VALUES (1, ${new Date().toISOString()})
  `;
});
