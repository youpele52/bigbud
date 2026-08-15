import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  ThreadRetentionRepositoryShape,
  ThreadRetentionRetryState,
} from "../Services/ThreadRetentionRepository.ts";

const BASE_RETRY_DELAY_MS = 15 * 60 * 1_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
const FAILURE_WINDOW_MS = 60 * 60 * 1_000;
const CIRCUIT_REOPEN_MS = 24 * 60 * 60 * 1_000;

type RetryRow = Omit<ThreadRetentionRetryState, "circuitOpen">;

function toRetryState(row: RetryRow, now: string): ThreadRetentionRetryState {
  return {
    ...row,
    circuitOpen: row.circuitOpenUntil !== null && row.circuitOpenUntil > now,
  };
}

export function makeThreadRetentionRetry(sql: SqlClient.SqlClient) {
  const readRunRetryState = (runId: string, now: string) =>
    sql<RetryRow>`
      SELECT retry_ordinal AS "retryOrdinal",
        failure_window_started_at AS "failureWindowStartedAt",
        failure_count_in_window AS "failureCountInWindow",
        last_failure_at AS "lastFailureAt", next_attempt_at AS "nextAttemptAt",
        circuit_open_until AS "circuitOpenUntil"
      FROM thread_retention_runs WHERE run_id = ${runId}
    `.pipe(
      Effect.map((rows) =>
        Option.map(Option.fromNullishOr(rows[0]), (row) => toRetryState(row, now)),
      ),
    );

  const recordRunFailure = Effect.fn("ThreadRetentionRepository.recordRunFailure")(function* (
    input: Parameters<ThreadRetentionRepositoryShape["recordRunFailure"]>[0],
  ) {
    if (input.expectedStatuses.length === 0) return Option.none<ThreadRetentionRetryState>();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const failedAtMs = Date.parse(input.failedAt);
        const windowThreshold = new Date(failedAtMs - FAILURE_WINDOW_MS).toISOString();
        const rows = yield* sql<{
          retryOrdinal: number;
          failureWindowStartedAt: string;
          failureCountInWindow: number;
        }>`
            UPDATE thread_retention_runs SET
              retry_ordinal = retry_ordinal + 1,
              failure_window_started_at = CASE
                WHEN failure_window_started_at IS NULL
                  OR failure_window_started_at < ${windowThreshold}
                THEN ${input.failedAt} ELSE failure_window_started_at END,
              failure_count_in_window = CASE
                WHEN failure_window_started_at IS NULL
                  OR failure_window_started_at < ${windowThreshold}
                THEN 1 ELSE failure_count_in_window + 1 END,
              last_failure_at = ${input.failedAt}, last_error_code = ${input.lastErrorCode},
              updated_at = ${input.failedAt}
            WHERE run_id = ${input.runId} AND status IN ${sql.in(input.expectedStatuses)}
            RETURNING retry_ordinal AS "retryOrdinal",
              failure_window_started_at AS "failureWindowStartedAt",
              failure_count_in_window AS "failureCountInWindow"
          `;
        const row = rows[0];
        if (row === undefined) return Option.none<ThreadRetentionRetryState>();

        yield* sql`
            INSERT INTO thread_retention_failures (run_id, retry_ordinal, failed_at, error_code)
            VALUES (${input.runId}, ${row.retryOrdinal}, ${input.failedAt}, ${input.lastErrorCode})
          `;
        const recentFailures = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM (
              SELECT 1 FROM thread_retention_failures
              WHERE failed_at >= ${windowThreshold}
              ORDER BY failed_at DESC, run_id ASC, retry_ordinal DESC LIMIT 3
            )
          `;

        const retryDelay = Math.min(
          BASE_RETRY_DELAY_MS * 2 ** Math.max(0, row.retryOrdinal - 1),
          MAX_RETRY_DELAY_MS,
        );
        const circuitOpenUntil =
          (recentFailures[0]?.count ?? 0) >= 3
            ? new Date(failedAtMs + CIRCUIT_REOPEN_MS).toISOString()
            : null;
        const nextAttemptAt = circuitOpenUntil ?? new Date(failedAtMs + retryDelay).toISOString();
        yield* sql`
            UPDATE thread_retention_runs SET next_attempt_at = CASE
                WHEN ${input.isolateItemFailure === true ? 1 : 0} = 1
                THEN next_attempt_at ELSE ${nextAttemptAt} END,
              circuit_open_until = ${circuitOpenUntil}
            WHERE run_id = ${input.runId} AND retry_ordinal = ${row.retryOrdinal}
              AND last_failure_at = ${input.failedAt}
          `;
        return Option.some({
          retryOrdinal: row.retryOrdinal,
          failureWindowStartedAt: row.failureWindowStartedAt,
          failureCountInWindow: row.failureCountInWindow,
          lastFailureAt: input.failedAt,
          nextAttemptAt,
          circuitOpenUntil,
          circuitOpen: circuitOpenUntil !== null,
        });
      }),
    );
  });

  const clearRunRetryState = (
    input: Parameters<ThreadRetentionRepositoryShape["clearRunRetryState"]>[0],
  ) => {
    if (input.expectedStatuses.length === 0) return Effect.succeed(false);
    return sql`
      UPDATE thread_retention_runs SET retry_ordinal = 0,
        failure_window_started_at = NULL, failure_count_in_window = 0,
        last_failure_at = NULL, next_attempt_at = NULL, circuit_open_until = NULL,
        last_error_code = NULL, updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId} AND status IN ${sql.in(input.expectedStatuses)}
      RETURNING run_id
    `.pipe(Effect.map((rows) => rows.length === 1));
  };

  const getRecentFailureSummary = (
    input: Parameters<ThreadRetentionRepositoryShape["getRecentFailureSummary"]>[0],
  ) => {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    return sql<{ failedAt: string; retryOrdinal: number }>`
      SELECT failed_at AS "failedAt", retry_ordinal AS "retryOrdinal"
      FROM thread_retention_failures WHERE failed_at >= ${input.since}
      ORDER BY failed_at DESC, run_id ASC, retry_ordinal DESC LIMIT ${limit}
    `.pipe(
      Effect.map((rows) => ({
        failureCount: rows.length,
        latestFailureAt: rows[0]?.failedAt ?? null,
        consecutiveFailureCount: rows[0]?.retryOrdinal ?? 0,
      })),
    );
  };

  return {
    recordRunFailure,
    readRunRetryState,
    clearRunRetryState,
    getRecentFailureSummary,
  };
}
