import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Retained evidence deliberately has no cascading thread FK or expiry-based replay policy. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_metadata_generation_jobs (
    job_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('title', 'summary')),
    generation_key TEXT NOT NULL,
    config_epoch TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
      'pending', 'waiting-model', 'waiting-native', 'running', 'uncertain', 'result-ready',
      'completed', 'stale', 'cancelled', 'exhausted', 'unavailable', 'quarantined'
    )),
    context_json TEXT NOT NULL CHECK(json_valid(context_json)),
    expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
    source_frontier INTEGER NOT NULL CHECK(source_frontier >= 0),
    workspace_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    model_wait_until TEXT NOT NULL,
    native_wait_until TEXT NOT NULL,
    next_attempt_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    UNIQUE(thread_id, operation, generation_key)
  )`;
  yield* sql`CREATE UNIQUE INDEX thread_metadata_generation_jobs_open
    ON thread_metadata_generation_jobs(thread_id, operation)
    WHERE state IN (
      'pending', 'waiting-model', 'waiting-native', 'running', 'uncertain', 'result-ready'
    )`;
  yield* sql`CREATE INDEX thread_metadata_generation_jobs_due
    ON thread_metadata_generation_jobs(state, next_attempt_at, job_id)`;
  yield* sql`CREATE TABLE thread_metadata_generation_attempts (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES thread_metadata_generation_jobs(job_id),
    thread_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK(stage IN ('primary', 'thread-model', 'native')),
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
    owner TEXT NOT NULL,
    execution_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
      'prepared', 'dispatch-intent', 'acknowledged', 'uncertain', 'result-ready',
      'completed', 'failed', 'stale', 'cancelled', 'unavailable'
    )),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    result TEXT,
    provider_session_id TEXT,
    provider_turn_id TEXT,
    session_epoch INTEGER,
    created_at TEXT NOT NULL,
    dispatched_at TEXT,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    CHECK(stage = 'primary' OR ordinal = 1),
    CHECK(state NOT IN ('result-ready', 'completed') OR result IS NOT NULL),
    UNIQUE(job_id, stage, ordinal)
  )`;
  yield* sql`CREATE UNIQUE INDEX thread_metadata_generation_attempts_open
    ON thread_metadata_generation_attempts(job_id)
    WHERE state IN ('prepared', 'dispatch-intent', 'acknowledged', 'uncertain', 'result-ready')`;
  yield* sql`CREATE UNIQUE INDEX thread_metadata_generation_native_open
    ON thread_metadata_generation_attempts(thread_id)
    WHERE stage = 'native'
      AND state IN ('prepared', 'dispatch-intent', 'acknowledged', 'uncertain', 'result-ready')`;
  yield* sql`CREATE TABLE thread_metadata_generation_state (
    thread_id TEXT PRIMARY KEY,
    title_revision INTEGER NOT NULL DEFAULT 0 CHECK(title_revision >= 0),
    summary_revision INTEGER NOT NULL DEFAULT 0 CHECK(summary_revision >= 0),
    summary_attempted_frontier INTEGER NOT NULL DEFAULT 0 CHECK(summary_attempted_frontier >= 0),
    successful_model_json TEXT CHECK(successful_model_json IS NULL OR json_valid(successful_model_json))
  )`;
  yield* sql`CREATE TABLE thread_metadata_generation_warnings (
    warning_id TEXT PRIMARY KEY,
    config_epoch TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('title', 'summary')),
    created_at TEXT NOT NULL,
    claimed_by TEXT,
    claim_until TEXT,
    acknowledged_at TEXT
  )`;
  yield* sql`CREATE INDEX thread_metadata_generation_warnings_pending
    ON thread_metadata_generation_warnings(acknowledged_at, created_at, warning_id)`;
});
