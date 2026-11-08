/**
 * Removes most of a proven thread deletion's canonical events in short transactions, so the
 * pipeline's atomic `finalizeThreadCanonicalHistoryWithCoverage` that follows only has a small
 * remainder left. Deleting a large thread's history in one transaction holds the single SQLite
 * worker for seconds (about 75 µs per event on the measured 4-million-event log).
 *
 * Each chunk re-checks the same canonical proof the finalize uses, records gap rows for the
 * sequences it removes (exactly as the finalize does), and never removes the deletion event
 * itself, so the deletion stays listed until the finalize completes it. A crash between chunks
 * leaves a consistent log: removed sequences read as gaps, and the next tick continues.
 *
 * @module CanonicalThreadCleanup.chunked
 */
import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { verifyCanonicalPurgeProof } from "./EntityPurge.proof.ts";
import { makeEntityPurgeSql } from "./EntityPurge.sql.ts";

export const CANONICAL_TRIM_CHUNK = 500;

/**
 * Trims until fewer than one chunk of events is left (returns `true`) or `deadlineMs` passes
 * (returns `false`, to be resumed by a later tick). Fails when the deletion is not proven.
 */
export const trimProvenThreadHistory = Effect.fn("trimProvenThreadHistory")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  deadlineMs: number,
) {
  const queries = makeEntityPurgeSql(sql);
  for (;;) {
    if (Date.now() >= deadlineMs) return false;
    const removed = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* verifyCanonicalPurgeProof({ queries, entityKind: "thread", entityId: threadId });
        const rows = yield* sql<{ readonly sequence: number }>`
          WITH root AS (
            SELECT deletion_sequence FROM orchestration_deletion_markers
            WHERE entity_kind = 'thread' AND entity_id = ${threadId}
          )
          SELECT sequence FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id IN (
              SELECT entity_id FROM orchestration_deletion_markers
              WHERE entity_kind = 'thread'
                AND deletion_sequence = (SELECT deletion_sequence FROM root)
            )
            AND sequence <> (SELECT deletion_sequence FROM root)
          LIMIT ${CANONICAL_TRIM_CHUNK}
        `;
        if (rows.length < CANONICAL_TRIM_CHUNK) return rows.length;
        const sequences = JSON.stringify(rows.map((row) => row.sequence));
        yield* sql`
          INSERT INTO orchestration_event_gaps (sequence, event_id, created_at)
          SELECT sequence, event_id, ${new Date().toISOString()} FROM orchestration_events
          WHERE sequence IN (SELECT value FROM json_each(${sequences}))
          ON CONFLICT (sequence) DO NOTHING
        `;
        yield* sql`
          DELETE FROM orchestration_event_ids
          WHERE sequence IN (SELECT value FROM json_each(${sequences}))
        `;
        yield* sql`
          DELETE FROM orchestration_events
          WHERE sequence IN (SELECT value FROM json_each(${sequences}))
        `;
        return rows.length;
      }),
    );
    if (removed < CANONICAL_TRIM_CHUNK) return true;
    yield* Effect.yieldNow;
  }
});
