import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export function makeThreadRetentionAudit(sql: SqlClient.SqlClient) {
  return Effect.fn("ThreadRetentionRepository.cleanupAudit")(function* (input: {
    readonly olderThan: string;
    readonly keepLatest: number;
  }) {
    const keepLatest = Math.max(1, Math.min(500, Math.floor(input.keepLatest)));
    const limit = 100;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const challenges = yield* sql`
          DELETE FROM thread_retention_consent_challenges
          WHERE challenge_id IN (
            SELECT challenge_id FROM thread_retention_consent_challenges
            WHERE expires_at < ${input.olderThan} OR consumed_at < ${input.olderThan}
            ORDER BY issued_at ASC, challenge_id ASC LIMIT ${limit}
          ) RETURNING challenge_id
        `;
        const remaining = Math.max(0, limit - challenges.length);
        const runs = yield* sql`
          DELETE FROM thread_retention_runs WHERE run_id IN (
            SELECT run_id FROM thread_retention_runs
            WHERE completed_at IS NOT NULL AND completed_at < ${input.olderThan}
              AND run_id NOT IN (
                SELECT run_id FROM thread_retention_runs
                ORDER BY created_at DESC, run_id DESC LIMIT ${keepLatest}
              )
            ORDER BY completed_at ASC, run_id ASC LIMIT ${remaining}
          ) RETURNING run_id
        `;
        return challenges.length + runs.length;
      }),
    );
  });
}
