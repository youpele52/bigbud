import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Expiry revokes tool access, never the reservation for potentially dispatched work. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_metadata_generation_native_receipts (
    attempt_id TEXT PRIMARY KEY REFERENCES thread_metadata_generation_attempts(attempt_id),
    grant_digest TEXT NOT NULL UNIQUE CHECK(length(grant_digest) = 64),
    provider_session_id TEXT NOT NULL CHECK(length(provider_session_id) > 0),
    provider_turn_id TEXT NOT NULL CHECK(length(provider_turn_id) > 0),
    session_epoch INTEGER NOT NULL CHECK(session_epoch >= 0),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL CHECK(expires_at > issued_at),
    terminal_outcome TEXT CHECK(terminal_outcome IN ('completed', 'failed', 'cancelled')),
    terminal_receipt_json TEXT CHECK(terminal_receipt_json IS NULL OR json_valid(terminal_receipt_json)),
    terminal_at TEXT,
    CHECK((terminal_outcome IS NULL AND terminal_receipt_json IS NULL AND terminal_at IS NULL)
      OR (terminal_outcome IS NOT NULL AND terminal_receipt_json IS NOT NULL AND terminal_at IS NOT NULL))
  )`;
});
