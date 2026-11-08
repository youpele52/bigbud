/**
 * One bounded transaction per call for the event-ID and gap ledgers the event log leaves behind
 * (receipts and claims are in `EventLogMaintenance.receipts`):
 *
 * - Gap rows at or below `retained_through_sequence`: replay already reports a gap there.
 * - `orchestration_event_ids` rows at or below `retained_through_sequence`, through
 *   `idx_orchestration_event_ids_sequence` (migration 155). Sequences come from the frontier,
 *   never from this table, so pruning it cannot reuse a sequence.
 *
 * @module EventLogMaintenance.ledgers
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";

const changes = (sql: SqlClient.SqlClient) =>
  sql<{ readonly count: number }>`SELECT changes() AS "count"`.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

export const pruneGapRows = Effect.fn("EventLogMaintenance.pruneGapRows")(
  function* (sql: SqlClient.SqlClient, throughSequence: number, limit: number) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM orchestration_event_gaps WHERE sequence IN (
            SELECT sequence FROM orchestration_event_gaps
            WHERE sequence <= ${throughSequence} ORDER BY sequence LIMIT ${limit}
          )
        `;
        return yield* changes(sql);
      }),
    );
  },
  Effect.mapError(toPersistenceSqlError("EventLogMaintenance.pruneGapRows")),
);

/** Exposed for the query-plan test. */
export const EVENT_ID_PRUNE_SELECT =
  "SELECT rowid FROM orchestration_event_ids WHERE sequence <= ? ORDER BY sequence LIMIT ?";

export const pruneEventIds = Effect.fn("EventLogMaintenance.pruneEventIds")(
  function* (sql: SqlClient.SqlClient, throughSequence: number, limit: number) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `DELETE FROM orchestration_event_ids WHERE rowid IN (${EVENT_ID_PRUNE_SELECT})`,
          [throughSequence, limit],
        );
        return yield* changes(sql);
      }),
    );
  },
  Effect.mapError(toPersistenceSqlError("EventLogMaintenance.pruneEventIds")),
);
