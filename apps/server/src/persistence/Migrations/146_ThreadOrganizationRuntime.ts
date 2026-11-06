import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Authoritative TS runtime state, NOT disposable projections. Baseline restore,
// compaction and projection rebuild must never clear or restore these tables.
// No projection FK: absence during rebuild is not evidence of thread deletion.
// Existing snooze identity/deadline remains solely in projection_threads.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_organization_runtime (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    policy_version INTEGER NOT NULL DEFAULT 0 CHECK (policy_version BETWEEN 0 AND 9007199254740991),
    policy_fingerprint TEXT NOT NULL DEFAULT '',
    short_fingerprint TEXT NOT NULL DEFAULT '',
    older_fingerprint TEXT NOT NULL DEFAULT '',
    target_fingerprint TEXT NOT NULL DEFAULT '',
    short_policy_changed_at_ms INTEGER,
    older_policy_changed_at_ms INTEGER,
    target_drain_not_before_ms INTEGER,
    onboarding_decision TEXT NOT NULL DEFAULT 'existing-opt-in' CHECK (onboarding_decision = 'existing-opt-in'),
    onboarding_version INTEGER NOT NULL DEFAULT 1 CHECK (onboarding_version = 1),
    canonical_frontier INTEGER NOT NULL DEFAULT 0 CHECK (canonical_frontier BETWEEN 0 AND 9007199254740991)
  )`;
  // No settings-file/default inference, and no target activation. New-install
  // classification/onboarding is a separately gated future milestone.
  yield* sql`INSERT INTO thread_organization_runtime (singleton) VALUES (1)`;
  yield* sql`CREATE TABLE thread_organization_runtime_threads (
    thread_id TEXT PRIMARY KEY NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 256),
    fact_version INTEGER NOT NULL CHECK (fact_version BETWEEN 1 AND 9007199254740991),
    source_frontier INTEGER NOT NULL CHECK (source_frontier BETWEEN 0 AND 9007199254740991),
    transition_digest TEXT NOT NULL,
    last_work_completed_at_ms INTEGER,
    deliberate_organization_at_ms INTEGER,
    manual_until_ms INTEGER,
    attention_watermark INTEGER NOT NULL CHECK (attention_watermark BETWEEN 0 AND 9007199254740991),
    grace_until_ms INTEGER,
    latest_automatic_move_id TEXT,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
  )`;
});
