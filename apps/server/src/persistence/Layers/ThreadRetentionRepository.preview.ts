import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ThreadRetentionExclusionReason } from "../Services/ThreadRetentionRepository.ts";
import {
  retentionExclusionCase,
  retentionVisibleActivitySql,
} from "./ThreadRetentionRepository.eligibility.ts";
import {
  retentionEligibleRootFromSql,
  retentionSubtreeCteSql,
} from "./ThreadRetentionRepository.pages.ts";

const THREAD_LIMIT = 250;
const ATTACHMENT_LIMIT = 1_000;
const CHECKPOINT_LIMIT = 1_000;
const BYTE_LIMIT = 100 * 1024 * 1024;

export function makeThreadRetentionPreview(sql: SqlClient.SqlClient) {
  const exclusion = retentionExclusionCase(sql);

  return Effect.fn("ThreadRetentionRepository.preview")(function* (cutoffAt: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const totals = yield* sql.unsafe<{
          eligibleCount: number;
          oldest: string | null;
          newest: string | null;
        }>(
          `${retentionSubtreeCteSql}
          SELECT COUNT(*) AS "eligibleCount", MIN(activity.last_activity_at) AS oldest,
            MAX(activity.last_activity_at) AS newest
          ${retentionEligibleRootFromSql}`,
          [cutoffAt],
        );
        const exclusions = yield* sql<{
          reason: ThreadRetentionExclusionReason;
          count: number;
        }>`
          SELECT reason, COUNT(*) AS count FROM (
            SELECT ${exclusion} AS reason FROM projection_threads AS t
            WHERE ${sql.unsafe(retentionVisibleActivitySql("t"))} <= ${cutoffAt}
          ) WHERE reason IS NOT NULL GROUP BY reason ORDER BY reason ASC
        `;
        const estimates = yield* sql
          .unsafe<{
            attachmentCount: number;
            attachmentRows: number;
            attachmentBytes: number;
            checkpointCount: number;
            checkpointRows: number;
            checkpointBytes: number;
            worktreeCount: number;
          }>(
            `${retentionSubtreeCteSql},
          eligible_roots AS (
            SELECT t.thread_id AS thread_id, activity.last_activity_at AS last_activity_at
            ${retentionEligibleRootFromSql}
          ), candidates AS (
            SELECT subtree.thread_id, thread.worktree_path
            FROM eligible_roots
            JOIN thread_subtree AS subtree ON subtree.root_thread_id = eligible_roots.thread_id
            JOIN projection_threads AS thread ON thread.thread_id = subtree.thread_id
            ORDER BY eligible_roots.last_activity_at ASC, eligible_roots.thread_id ASC,
              subtree.thread_id ASC
            LIMIT ${THREAD_LIMIT}
          ), attachment_rows AS (
            SELECT COALESCE(json_extract(attachment.value, '$.sizeBytes'), 0) AS known_bytes
            FROM projection_thread_messages AS message
            JOIN candidates ON candidates.thread_id = message.thread_id
            JOIN json_each(
              CASE
                WHEN json_valid(message.attachments_json) THEN message.attachments_json
                ELSE '[]'
              END
            ) AS attachment
            UNION ALL
            SELECT COALESCE(
              json_extract(activity.payload_json, '$.data.result.screenshot.sizeBytes'), 0
            )
            FROM projection_thread_activities AS activity
            JOIN candidates ON candidates.thread_id = activity.thread_id
            WHERE activity.kind = 'tool.completed'
              AND json_valid(activity.payload_json)
              AND json_extract(activity.payload_json, '$.title') = 'computer_use'
              AND json_type(activity.payload_json, '$.data.result.screenshot.attachmentId') = 'text'
            LIMIT ${ATTACHMENT_LIMIT + 1}
          ), checkpoints AS (
            SELECT length(CAST(checkpoint.diff AS BLOB)) AS known_bytes
            FROM checkpoint_diff_blobs AS checkpoint
            JOIN candidates ON candidates.thread_id = checkpoint.thread_id
            LIMIT ${CHECKPOINT_LIMIT + 1}
          )
          SELECT
            (SELECT MIN(COUNT(*), ${ATTACHMENT_LIMIT}) FROM attachment_rows)
              AS "attachmentCount",
            (SELECT COUNT(*) FROM attachment_rows) AS "attachmentRows",
            COALESCE((SELECT SUM(known_bytes) FROM (
              SELECT known_bytes FROM attachment_rows LIMIT ${ATTACHMENT_LIMIT}
            )), 0) AS "attachmentBytes",
            (SELECT MIN(COUNT(*), ${CHECKPOINT_LIMIT}) FROM checkpoints) AS "checkpointCount",
            (SELECT COUNT(*) FROM checkpoints) AS "checkpointRows",
            COALESCE((SELECT SUM(known_bytes) FROM (
              SELECT known_bytes FROM checkpoints LIMIT ${CHECKPOINT_LIMIT}
            )), 0) AS "checkpointBytes",
            (SELECT COUNT(*) FROM candidates WHERE worktree_path IS NOT NULL) AS "worktreeCount"`,
            [cutoffAt],
          )
          .pipe(
            Effect.map((rows) => ({ rows, failed: false as const })),
            Effect.catch(() =>
              Effect.succeed({
                rows: [
                  {
                    attachmentCount: 0,
                    attachmentRows: 0,
                    attachmentBytes: 0,
                    checkpointCount: 0,
                    checkpointRows: 0,
                    checkpointBytes: 0,
                    worktreeCount: 0,
                  },
                ],
                failed: true as const,
              }),
            ),
          );
        const total = totals[0];
        const estimate = estimates.rows[0];
        const eligibleCount = total?.eligibleCount ?? 0;
        const attachmentCount = estimate?.attachmentCount ?? 0;
        const checkpointCount = estimate?.checkpointCount ?? 0;
        const candidateComplete = !estimates.failed && eligibleCount <= THREAD_LIMIT;
        const attachmentComplete =
          !estimates.failed && (estimate?.attachmentRows ?? 0) <= ATTACHMENT_LIMIT;
        const checkpointComplete =
          !estimates.failed && (estimate?.checkpointRows ?? 0) <= CHECKPOINT_LIMIT;
        const knownBytes = (estimate?.attachmentBytes ?? 0) + (estimate?.checkpointBytes ?? 0);
        const resourceComplete = candidateComplete && attachmentComplete && checkpointComplete;

        return {
          eligibleCount,
          oldestEligibleActivityAt: total?.oldest ?? null,
          newestEligibleActivityAt: total?.newest ?? null,
          exclusionCounts: exclusions.map((row) => ({ reason: row.reason, count: row.count })),
          estimatedAttachmentCount: attachmentCount,
          estimatedResourceCount:
            attachmentCount + checkpointCount + (estimate?.worktreeCount ?? 0),
          estimatedKnownBytes: Math.min(knownBytes, BYTE_LIMIT),
          attachmentEstimateComplete: candidateComplete && attachmentComplete,
          resourceEstimateComplete: resourceComplete,
          bytesEstimateComplete: resourceComplete && knownBytes <= BYTE_LIMIT,
        };
      }),
    );
  });
}
