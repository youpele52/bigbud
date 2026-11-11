import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { orchestrationSequenceFrontierSql } from "../OrchestrationSequenceFrontier.ts";

/** Migrator runs this snapshot transactionally. Historical unidentified claims cannot
 * belong to a genuinely new thread created after this boundary. Retain their exact
 * evidence and all prior IDs: identity.created_sequence can change on recreation.
 * The canonical frontier includes retained prefixes and gaps; AUTOINCREMENT also
 * preserves a higher deleted head. Wall-clock timestamps prove no ordering.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_metadata_legacy_claim_boundary (
    command_id TEXT PRIMARY KEY,
    payload_digest_version TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0)
  )`;
  yield* sql`CREATE TABLE thread_metadata_legacy_prior_threads (thread_id TEXT PRIMARY KEY)`;
  yield* sql`INSERT INTO thread_metadata_legacy_prior_threads (thread_id)
    SELECT thread_id FROM orchestration_thread_identity
    UNION SELECT thread_id FROM projection_threads
    UNION SELECT stream_id FROM orchestration_stream_state WHERE aggregate_kind = 'thread'
    UNION SELECT entity_id FROM orchestration_deletion_markers WHERE entity_kind = 'thread'`;
  yield* sql`INSERT INTO thread_metadata_legacy_claim_boundary
    (command_id, payload_digest_version, payload_digest, claimed_at, through_sequence)
    SELECT c.command_id, c.payload_digest_version, c.payload_digest, c.claimed_at,
      MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'), 0),
        ${orchestrationSequenceFrontierSql(sql)})
    FROM orchestration_command_receipt_claims c
    WHERE c.command_id LIKE 'server:text-generation-status:%'
      AND NOT EXISTS (SELECT 1 FROM orchestration_command_receipts r WHERE r.command_id = c.command_id)
      AND NOT EXISTS (SELECT 1 FROM projection_thread_activities a
        WHERE a.activity_id = substr(c.command_id, 8) AND a.kind LIKE 'text-generation.%')`;
});
