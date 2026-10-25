import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { estimateObservableTokens, OBSERVABLE_ESTIMATOR_VERSION } from "../usageObservable.ts";

/** Resumable bounded scan; compare text and timestamp so concurrent live updates win. */
export function runUsageEstimateBackfill(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const missing = yield* sql`SELECT 1 FROM projection_thread_messages
      WHERE observable_token_count IS NULL OR observable_estimator_version IS NOT ${OBSERVABLE_ESTIMATOR_VERSION} LIMIT 1`;
    if (missing.length > 0) {
      yield* sql`UPDATE projection_usage_estimate_backfill_state SET completed = 0, last_message_id = '' WHERE completed = 1`;
    }
    while (true) {
      const [state] = yield* sql<{
        last_message_id: string;
        completed: number;
      }>`SELECT * FROM projection_usage_estimate_backfill_state WHERE id = 1`;
      if (!state || state.completed === 1) return;
      const rows = yield* sql<{
        message_id: string;
        text: string;
        updated_at: string;
      }>`SELECT message_id, text, updated_at
        FROM projection_thread_messages WHERE message_id > ${state.last_message_id}
        ORDER BY message_id LIMIT 100`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const row of rows) {
            yield* sql`UPDATE projection_thread_messages
            SET observable_token_count = ${estimateObservableTokens(row.text)}, observable_estimator_version = ${OBSERVABLE_ESTIMATOR_VERSION}
            WHERE message_id = ${row.message_id} AND text = ${row.text} AND updated_at = ${row.updated_at}`;
          }
          yield* sql`UPDATE projection_usage_estimate_backfill_state
          SET last_message_id = ${rows.at(-1)?.message_id ?? state.last_message_id}, completed = ${rows.length === 0 ? 1 : 0}, updated_at = ${new Date().toISOString()}
          WHERE id = 1`;
        }),
      );
      yield* Effect.yieldNow;
    }
  });
}
