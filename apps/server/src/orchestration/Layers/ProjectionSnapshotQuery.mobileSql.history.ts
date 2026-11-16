import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  THREAD_DETAIL_ACTIVITY_DEFAULT_LIMIT,
  THREAD_DETAIL_APPROVAL_DEFAULT_LIMIT,
  THREAD_DETAIL_MESSAGE_DEFAULT_LIMIT,
  THREAD_DETAIL_USER_INPUT_DEFAULT_LIMIT,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";

import {
  MobileThreadActivityDbRowSchema,
  MobileThreadMessageDbRowSchema,
  mobileActivityPayloadColumnsSql,
  mobileMessageTextColumnsSql,
} from "./ProjectionSnapshotQuery.mobileSql.bounds.ts";

/**
 * Approval and user-input history per thread and kind, matching the desktop detail windows
 * (`THREAD_DETAIL_APPROVAL_DEFAULT_LIMIT` requests, each a requested/resolved pair). Pending
 * requests are always kept, whatever their age.
 */
const MOBILE_HISTORY_ACTIVITY_LIMIT =
  Math.max(THREAD_DETAIL_APPROVAL_DEFAULT_LIMIT, THREAD_DETAIL_USER_INPUT_DEFAULT_LIMIT) * 2;

/**
 * The selected thread's newest messages, plus one so assembly can tell whether older history
 * exists. Assembly trims back to `THREAD_DETAIL_MESSAGE_DEFAULT_LIMIT` and the page text budget.
 */
export const MOBILE_SELECTED_MESSAGE_FETCH_LIMIT = THREAD_DETAIL_MESSAGE_DEFAULT_LIMIT + 1;

/**
 * Newest activities kept for the selected thread, and for each active thread's latest turn. The
 * approval/user-input history window and pending requests are unioned in on top of this.
 */
export const MOBILE_ACTIVITY_WINDOW_LIMIT = THREAD_DETAIL_ACTIVITY_DEFAULT_LIMIT;

const MobileRecoveryHistoryQueryInput = Schema.Struct({
  selectedThreadId: Schema.NullOr(ThreadId),
});

export function makeMobileHistoryQueries(sql: SqlClient.SqlClient) {
  const listMessageRows = SqlSchema.findAll({
    Request: MobileRecoveryHistoryQueryInput,
    Result: MobileThreadMessageDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        WITH selected_thread AS (
          SELECT thread_id
          FROM projection_threads
          WHERE thread_id = ${selectedThreadId} AND deleted_at IS NULL
        ), message_ids AS (
          SELECT message_id FROM (
            SELECT messages.message_id
            FROM projection_thread_messages AS messages
            INNER JOIN selected_thread
              ON selected_thread.thread_id = messages.thread_id
            ORDER BY messages.created_at DESC, messages.message_id DESC
            LIMIT ${MOBILE_SELECTED_MESSAGE_FETCH_LIMIT}
          )
          UNION
          SELECT messages.message_id
          FROM projection_threads AS threads
          INNER JOIN projection_thread_messages AS messages
            ON messages.rowid IN (
              SELECT candidate.rowid
              FROM projection_thread_messages AS candidate
              WHERE candidate.thread_id = threads.thread_id
              ORDER BY candidate.created_at DESC, candidate.message_id DESC
              LIMIT 4
            )
          WHERE threads.archived_at IS NULL AND threads.deleted_at IS NULL
        )
        SELECT
          messages.message_id AS "messageId",
          messages.thread_id AS "threadId",
          messages.turn_id AS "turnId",
          messages.role,
          ${mobileMessageTextColumnsSql(sql)},
          messages.attachments_json AS "attachments",
          messages.reply_to_json AS "replyTo",
          messages.origin_segments_json AS "originSegments",
          messages.is_streaming AS "isStreaming",
          messages.created_at AS "createdAt",
          messages.updated_at AS "updatedAt"
        FROM projection_thread_messages AS messages
        INNER JOIN message_ids ON message_ids.message_id = messages.message_id
        ORDER BY messages.thread_id ASC, messages.created_at ASC, messages.message_id ASC
      `,
  });

  const listActivityRows = SqlSchema.findAll({
    Request: MobileRecoveryHistoryQueryInput,
    Result: MobileThreadActivityDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        WITH selected_thread AS (
          SELECT thread_id
          FROM projection_threads
          WHERE thread_id = ${selectedThreadId} AND deleted_at IS NULL
        ), activity_ids AS (
          SELECT activity_id FROM (
            SELECT activities.activity_id
            FROM projection_thread_activities AS activities
            INNER JOIN selected_thread
              ON selected_thread.thread_id = activities.thread_id
            ORDER BY activities.sequence DESC, activities.created_at DESC,
              activities.activity_id DESC
            LIMIT ${MOBILE_ACTIVITY_WINDOW_LIMIT}
          )
          UNION
          SELECT activity_id FROM (
            SELECT activities.activity_id,
              ROW_NUMBER() OVER (
                PARTITION BY activities.thread_id
                ORDER BY activities.sequence DESC, activities.created_at DESC,
                  activities.activity_id DESC
              ) AS turn_rank
            FROM projection_threads AS threads
            INNER JOIN projection_thread_activities AS activities
              ON activities.thread_id = threads.thread_id
             AND activities.turn_id = threads.latest_turn_id
            WHERE threads.archived_at IS NULL AND threads.deleted_at IS NULL
          )
          WHERE turn_rank <= ${MOBILE_ACTIVITY_WINDOW_LIMIT}
          UNION
          SELECT activity_id FROM (
            SELECT activities.activity_id,
              ROW_NUMBER() OVER (
                PARTITION BY activities.thread_id,
                  CASE WHEN activities.kind COLLATE BINARY < 'approval/' THEN 0 ELSE 1 END
                ORDER BY activities.sequence DESC, activities.created_at DESC,
                  activities.activity_id DESC
              ) AS history_rank
            FROM projection_threads AS threads
            INNER JOIN projection_thread_activities AS activities
              ON activities.thread_id = threads.thread_id
            WHERE threads.archived_at IS NULL
              AND threads.deleted_at IS NULL
              AND (
                (activities.kind COLLATE BINARY >= 'approval.'
                  AND activities.kind COLLATE BINARY < 'approval/')
                OR (activities.kind COLLATE BINARY >= 'user-input.'
                  AND activities.kind COLLATE BINARY < 'user-input/')
              )
          )
          WHERE history_rank <= ${MOBILE_HISTORY_ACTIVITY_LIMIT}
          UNION
          SELECT activities.activity_id
          FROM projection_pending_approvals AS pending
          INNER JOIN projection_thread_activities AS activities
            ON activities.thread_id = pending.thread_id
           AND activities.kind = 'approval.requested'
           AND json_extract(activities.payload_json, '$.requestId') = pending.request_id
          WHERE pending.status = 'pending'
          UNION
          SELECT activities.activity_id
          FROM projection_pending_user_inputs AS pending
          INNER JOIN projection_thread_activities AS activities
            ON activities.thread_id = pending.thread_id
           AND activities.kind = 'user-input.requested'
           AND json_extract(activities.payload_json, '$.requestId') = pending.request_id
          WHERE pending.status = 'pending'
        )
        SELECT
          activities.activity_id AS "activityId",
          activities.thread_id AS "threadId",
          activities.turn_id AS "turnId",
          activities.tone,
          activities.kind,
          activities.summary,
          ${mobileActivityPayloadColumnsSql(sql)},
          activities.sequence,
          activities.created_at AS "createdAt"
        FROM projection_thread_activities AS activities
        INNER JOIN activity_ids ON activity_ids.activity_id = activities.activity_id
        ORDER BY
          activities.thread_id ASC,
          CASE WHEN activities.sequence IS NULL THEN 0 ELSE 1 END ASC,
          activities.sequence ASC,
          activities.created_at ASC,
          activities.activity_id ASC
      `,
  });

  return { listActivityRows, listMessageRows } as const;
}
