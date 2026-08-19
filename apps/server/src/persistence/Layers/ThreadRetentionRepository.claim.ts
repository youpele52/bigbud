import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  RecheckAndClaimRetentionItemInput,
  ThreadRetentionExclusionReason,
} from "../Services/ThreadRetentionRepository.ts";
import { retentionExclusionCaseSql } from "./ThreadRetentionRepository.eligibility.ts";
import { retentionSubtreeCteSql } from "./ThreadRetentionRepository.pages.ts";

export function makeThreadRetentionClaim(sql: SqlClient.SqlClient) {
  const recheckAndClaimItem = Effect.fn("ThreadRetentionRepository.recheckAndClaimItem")(function* (
    input: RecheckAndClaimRetentionItemInput,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const claimed = yield* sql.unsafe<{ thread_id: string }>(
          `${retentionSubtreeCteSql}
          UPDATE thread_retention_run_items SET status = 'deletion_requested',
            next_attempt_at = NULL,
            attempt_count = attempt_count + 1, updated_at = ?
          WHERE run_id = ? AND thread_id = ? AND status = 'selected'
            AND expected_last_activity_at = ?
            AND EXISTS (
              SELECT 1 FROM projection_threads AS t
              JOIN subtree_activity AS activity ON activity.root_thread_id = t.thread_id
              WHERE t.thread_id = ?
                AND activity.last_activity_at = ?
                AND activity.last_activity_at <= ?
                AND (${retentionExclusionCaseSql}) IS NULL
            )
          RETURNING thread_id`,
          [
            input.claimedAt,
            input.runId,
            input.threadId,
            input.expectedLastActivityAt,
            input.threadId,
            input.expectedLastActivityAt,
            input.cutoffAt,
          ],
        );
        if (claimed.length === 1) {
          yield* sql`UPDATE thread_retention_runs SET requested_count = requested_count + 1,
            updated_at = ${input.claimedAt} WHERE run_id = ${input.runId}`;
          return { claimed: true } as const;
        }
        const rows = yield* sql.unsafe<{
          itemStatus: string;
          reason: ThreadRetentionExclusionReason | null;
        }>(
          `${retentionSubtreeCteSql}
          SELECT item.status AS "itemStatus",
            CASE WHEN t.thread_id IS NULL OR activity.last_activity_at <> ?
              OR activity.last_activity_at > ? THEN 'activity_changed'
              ELSE (${retentionExclusionCaseSql}) END AS reason
          FROM thread_retention_run_items AS item
          LEFT JOIN projection_threads AS t ON t.thread_id = item.thread_id
          LEFT JOIN subtree_activity AS activity ON activity.root_thread_id = item.thread_id
          WHERE item.run_id = ? AND item.thread_id = ?`,
          [input.expectedLastActivityAt, input.cutoffAt, input.runId, input.threadId],
        );
        const row = rows[0];
        if (row?.itemStatus !== "selected" || row.reason === null) {
          return { claimed: false, reason: "not_selected" } as const;
        }
        const skipped = yield* sql`
          UPDATE thread_retention_run_items SET status = 'skipped', exclusion_reason = ${row.reason},
            next_attempt_at = NULL,
            attempt_count = attempt_count + 1, updated_at = ${input.claimedAt}, completed_at = ${input.claimedAt}
          WHERE run_id = ${input.runId} AND thread_id = ${input.threadId} AND status = 'selected'
          RETURNING thread_id
        `;
        if (skipped.length === 1)
          yield* sql`
          UPDATE thread_retention_runs SET skipped_count = skipped_count + 1,
            updated_at = ${input.claimedAt} WHERE run_id = ${input.runId}
        `;
        return { claimed: false, reason: row.reason } as const;
      }),
    );
  });

  return { recheckAndClaimItem };
}
