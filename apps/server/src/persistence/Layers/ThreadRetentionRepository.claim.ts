import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  RecheckAndClaimRetentionItemInput,
  ThreadRetentionExclusionReason,
} from "../Services/ThreadRetentionRepository.ts";
import {
  retentionAgeSql,
  retentionExclusionCaseSql,
} from "./ThreadRetentionRepository.eligibility.ts";
import { retentionSubtreeCteSql } from "./ThreadRetentionRepository.pages.ts";

export function makeThreadRetentionClaim(sql: SqlClient.SqlClient) {
  const recheckAndClaimItem = Effect.fn("ThreadRetentionRepository.recheckAndClaimItem")(function* (
    input: RecheckAndClaimRetentionItemInput,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const runRows = yield* sql<{
          selectionMode: "legacy-subtree" | "per-thread";
          ageCriterion: "created" | "last-conversation-activity";
          cutoffAt: string;
        }>`
          SELECT selection_mode AS "selectionMode", age_criterion AS "ageCriterion",
            cutoff_at AS "cutoffAt"
          FROM thread_retention_runs WHERE run_id = ${input.runId} AND active_slot = 1
        `;
        const run = runRows[0];
        if (!run || run.cutoffAt !== input.cutoffAt)
          return { claimed: false, reason: "not_selected" } as const;
        const perThread = run.selectionMode === "per-thread";
        const cte = perThread ? "" : retentionSubtreeCteSql;
        const age = perThread
          ? retentionAgeSql("t", run.ageCriterion)
          : "activity.last_activity_at";
        const joins = perThread
          ? ""
          : `JOIN subtree_activity AS activity ON activity.root_thread_id = t.thread_id
          LEFT JOIN subtree_exclusions AS exclusion ON exclusion.root_thread_id = t.thread_id`;
        const eligible = perThread
          ? `(${retentionExclusionCaseSql("t", "per-thread")}) IS NULL`
          : "exclusion.reason IS NULL";
        const claimed = yield* sql.unsafe<{ thread_id: string }>(
          `${cte}
          UPDATE thread_retention_run_items SET status = 'deletion_requested',
            next_attempt_at = NULL,
            attempt_count = attempt_count + 1, updated_at = ?
          WHERE run_id = ? AND thread_id = ? AND status = 'selected'
            AND expected_last_activity_at = ?
            AND EXISTS (
              SELECT 1 FROM thread_retention_runs AS run
              WHERE run.run_id = ? AND run.active_slot = 1
            )
            AND EXISTS (
              SELECT 1 FROM projection_threads AS t
              ${joins}
              WHERE t.thread_id = ?
                AND ${age} = ? AND ${age} <= ?
                AND ${eligible}
            )
          RETURNING thread_id`,
          [
            input.claimedAt,
            input.runId,
            input.threadId,
            input.expectedLastActivityAt,
            input.runId,
            input.threadId,
            input.expectedLastActivityAt,
            input.cutoffAt,
          ],
        );
        if (claimed.length === 1) {
          yield* sql`UPDATE thread_retention_runs SET requested_count = requested_count + 1,
            uncertain_count = uncertain_count + 1,
            updated_at = ${input.claimedAt}
            WHERE run_id = ${input.runId} AND active_slot = 1`;
          return { claimed: true } as const;
        }
        const rows = yield* sql.unsafe<{
          itemStatus: string;
          reason: ThreadRetentionExclusionReason | null;
        }>(
          `${cte}
          SELECT item.status AS "itemStatus",
            CASE WHEN t.thread_id IS NULL OR ${age} <> ?
              OR ${age} > ? THEN 'activity_changed'
              ELSE ${perThread ? retentionExclusionCaseSql("t", "per-thread") : "exclusion.reason"} END AS reason
          FROM thread_retention_run_items AS item
          LEFT JOIN projection_threads AS t ON t.thread_id = item.thread_id
          ${
            perThread
              ? ""
              : `LEFT JOIN subtree_activity AS activity ON activity.root_thread_id = item.thread_id
          LEFT JOIN subtree_exclusions AS exclusion ON exclusion.root_thread_id = item.thread_id`
          }
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
            AND EXISTS (
              SELECT 1 FROM thread_retention_runs AS run
              WHERE run.run_id = ${input.runId} AND run.active_slot = 1
            )
          RETURNING thread_id
        `;
        if (skipped.length === 1)
          yield* sql`
          UPDATE thread_retention_runs SET skipped_count = skipped_count + 1,
            updated_at = ${input.claimedAt} WHERE run_id = ${input.runId} AND active_slot = 1
        `;
        return { claimed: false, reason: row.reason } as const;
      }),
    );
  });

  return { recheckAndClaimItem };
}
