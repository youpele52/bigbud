import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import type { OrchestrationEventStoreShape } from "../Services/OrchestrationEventStore.ts";

export function makeCompactVerifiedPrefix(
  sql: SqlClient.SqlClient,
): NonNullable<OrchestrationEventStoreShape["compactVerifiedPrefix"]> {
  return (requestedBatchSize = 500) => {
    const batchSize = Math.max(1, Math.min(10_000, Math.floor(requestedBatchSize)));
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const states = yield* sql<{
            retainedThroughSequence: number;
            compactThroughSequence: number;
          }>`
            SELECT retained_through_sequence AS "retainedThroughSequence",
              compact_through_sequence AS "compactThroughSequence"
            FROM orchestration_retention_state WHERE singleton_id = 1
          `;
          const state = states[0] ?? {
            retainedThroughSequence: 0,
            compactThroughSequence: 0,
          };
          const selected = yield* sql<{ sequence: number }>`
            SELECT sequence FROM orchestration_events
            WHERE sequence > ${state.retainedThroughSequence}
              AND sequence <= ${state.compactThroughSequence}
              AND EXISTS (
                SELECT 1 FROM projection_baselines
                WHERE verification_status = 'verified'
                  AND sequence >= orchestration_events.sequence
              )
            ORDER BY sequence ASC LIMIT ${batchSize}
          `;
          const lastDeleted = selected.at(-1)?.sequence;
          if (lastDeleted === undefined) {
            if (state.retainedThroughSequence < state.compactThroughSequence) {
              const updatedAt = new Date().toISOString();
              yield* sql`
                UPDATE orchestration_retention_state
                SET retained_through_sequence = ${state.compactThroughSequence},
                  updated_at = ${updatedAt}
                WHERE singleton_id = 1
              `;
            }
            return {
              ...state,
              retainedThroughSequence: state.compactThroughSequence,
              deletedCount: 0,
              complete: true,
            };
          }

          yield* sql`
            DELETE FROM orchestration_events
            WHERE sequence > ${state.retainedThroughSequence} AND sequence <= ${lastDeleted}
          `;
          const updatedAt = new Date().toISOString();
          yield* sql`
            UPDATE orchestration_retention_state
            SET retained_through_sequence = ${lastDeleted}, updated_at = ${updatedAt}
            WHERE singleton_id = 1
          `;
          return {
            deletedCount: selected.length,
            retainedThroughSequence: lastDeleted,
            compactThroughSequence: state.compactThroughSequence,
            complete: lastDeleted >= state.compactThroughSequence,
          };
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.compactVerifiedPrefix")),
      );
  };
}
