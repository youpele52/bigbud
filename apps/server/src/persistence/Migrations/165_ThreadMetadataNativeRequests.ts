import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A request exists before dispatch. The separate receipts row binds the real provider turn
 * only after acknowledgment; no placeholder turn ID can authorize tools or termination.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_metadata_generation_native_requests (
    attempt_id TEXT PRIMARY KEY REFERENCES thread_metadata_generation_attempts(attempt_id),
    provider_request_id TEXT NOT NULL UNIQUE CHECK(length(trim(provider_request_id)) > 0),
    grant_digest TEXT NOT NULL UNIQUE CHECK(length(grant_digest) = 64),
    provider_session_id TEXT NOT NULL CHECK(length(trim(provider_session_id)) > 0),
    session_epoch INTEGER NOT NULL CHECK(session_epoch >= 0),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL CHECK(expires_at > issued_at)
  )`;
});
