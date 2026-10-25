import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable recovery intent per accepted turn, and delivery progress of each provider dispatch
 * attempt up to `provider-acknowledged`. Both tables are new and empty, so the migration is
 * cheap on large databases. Turns accepted before it have no intent and are never continued
 * automatically.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No cascading FK: removing a thread must not license a replay.
  yield* sql`CREATE TABLE IF NOT EXISTS thread_recovery_intents (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    provider TEXT,
    turn_id TEXT,
    disposition TEXT NOT NULL DEFAULT 'active'
      CHECK(disposition IN ('active', 'suspended-for-exit', 'revoked', 'settled')),
    recovery_status TEXT NOT NULL DEFAULT 'none'
      CHECK(recovery_status IN (
        'none', 'interrupted-by-sleep', 'observing', 'continuing',
        'awaiting-user', 'parked', 'provider-continued', 'continued'
      )),
    recovery_detail_json TEXT NOT NULL DEFAULT '{}',
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    last_attempt_at TEXT,
    continuation_message_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, message_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS thread_recovery_intents_unresolved
    ON thread_recovery_intents(disposition, recovery_status, updated_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS thread_recovery_intents_continuation
    ON thread_recovery_intents(thread_id, continuation_message_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS provider_dispatch_attempts (
    attempt_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    intent_revision INTEGER NOT NULL CHECK(intent_revision >= 0),
    payload_digest TEXT NOT NULL,
    provider TEXT,
    turn_id TEXT,
    state TEXT NOT NULL
      CHECK(state IN ('prepared', 'may-have-been-sent', 'provider-acknowledged')),
    prepared_at TEXT NOT NULL,
    may_have_been_sent_at TEXT,
    acknowledged_at TEXT,
    updated_at TEXT NOT NULL
  )`;
  // At most one attempt per intent that the provider has not acknowledged.
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS provider_dispatch_attempts_open
    ON provider_dispatch_attempts(thread_id, message_id)
    WHERE state != 'provider-acknowledged'`;
  yield* sql`CREATE INDEX IF NOT EXISTS provider_dispatch_attempts_intent
    ON provider_dispatch_attempts(thread_id, message_id, prepared_at)`;
});
