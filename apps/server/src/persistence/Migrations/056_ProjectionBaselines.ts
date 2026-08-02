import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_baselines (
      baseline_id INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence INTEGER NOT NULL UNIQUE,
      format_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      verification_status TEXT NOT NULL
        CHECK (verification_status IN ('candidate', 'verified', 'rejected')),
      verification_detail TEXT,
      created_at TEXT NOT NULL,
      verified_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_baselines_verified_sequence
    ON projection_baselines(verification_status, sequence DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_retention_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      retained_through_sequence INTEGER NOT NULL DEFAULT 0,
      compact_through_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO orchestration_retention_state (
      singleton_id, retained_through_sequence, compact_through_sequence, updated_at
    ) VALUES (1, 0, 0, ${new Date(0).toISOString()})
    ON CONFLICT (singleton_id) DO NOTHING
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_stream_state (
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      last_stream_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (aggregate_kind, stream_id)
    )
  `;
  yield* sql`
    INSERT INTO orchestration_stream_state (
      aggregate_kind, stream_id, last_stream_version, updated_at
    )
    SELECT aggregate_kind, stream_id, MAX(stream_version), MAX(occurred_at)
    FROM orchestration_events
    GROUP BY aggregate_kind, stream_id
    ON CONFLICT (aggregate_kind, stream_id) DO UPDATE SET
      last_stream_version = MAX(last_stream_version, excluded.last_stream_version),
      updated_at = excluded.updated_at
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_event_ids (
      event_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO orchestration_event_ids (event_id, sequence)
    SELECT event_id, sequence FROM orchestration_events
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_deletion_markers (
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('project', 'thread')),
      entity_id TEXT NOT NULL,
      deletion_sequence INTEGER NOT NULL,
      deleted_at TEXT NOT NULL,
      covered_by_baseline_sequence INTEGER,
      PRIMARY KEY (entity_kind, entity_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_deletion_markers_coverage
    ON orchestration_deletion_markers(covered_by_baseline_sequence, deletion_sequence)
  `;
});
