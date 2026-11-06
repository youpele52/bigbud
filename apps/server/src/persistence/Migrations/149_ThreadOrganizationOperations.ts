import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Authoritative operation recovery, never projection/baseline-owned. The existing canonical
// command receipt remains the execution result authority; this preserves immutable proposals
// and confirmed early/no-op attempts so restarting cannot fork an uncertain operation.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_organization_operations (
    operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
    occurrence_id TEXT NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
    attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 9007199254740991),
    thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 256),
    payload_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (length(payload_json) <= 16384 AND json_valid(payload_json)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'applied', 'stale', 'not-due')),
    outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
    UNIQUE (occurrence_id, attempt),
    CHECK ((status = 'prepared') = (outcome_json IS NULL))
  )`;
  yield* sql`CREATE UNIQUE INDEX idx_organization_operation_thread_pending ON thread_organization_operations(thread_id)
    WHERE status = 'prepared'`;
  yield* sql`CREATE INDEX idx_organization_operations_pending ON thread_organization_operations(operation_id)
    WHERE status = 'prepared'`;
});
