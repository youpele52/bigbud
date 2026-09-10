import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

import {
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadMessageDbRowSchema,
} from "./ProjectionSnapshotQuerySql.ts";

const MobileRecoveryHistoryQueryInput = Schema.Struct({
  selectedThreadId: Schema.NullOr(ThreadId),
});

export function makeMobileHistoryQueries(sql: SqlClient.SqlClient) {
  const listMessageRows = SqlSchema.findAll({
    Request: MobileRecoveryHistoryQueryInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        WITH selected_thread AS (
          SELECT thread_id
          FROM projection_threads
          WHERE thread_id = ${selectedThreadId} AND deleted_at IS NULL
        ), message_ids AS (
          SELECT messages.message_id
          FROM projection_thread_messages AS messages
          INNER JOIN selected_thread
            ON selected_thread.thread_id = messages.thread_id
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
          messages.text,
          messages.attachments_json AS "attachments",
          messages.reply_to_json AS "replyTo",
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
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        WITH selected_thread AS (
          SELECT thread_id
          FROM projection_threads
          WHERE thread_id = ${selectedThreadId} AND deleted_at IS NULL
        ), activity_ids AS (
          SELECT activities.activity_id
          FROM projection_thread_activities AS activities
          INNER JOIN selected_thread
            ON selected_thread.thread_id = activities.thread_id
          UNION
          SELECT activities.activity_id
          FROM projection_threads AS threads
          INNER JOIN projection_thread_activities AS activities
            ON activities.thread_id = threads.thread_id
           AND activities.turn_id = threads.latest_turn_id
          WHERE threads.archived_at IS NULL AND threads.deleted_at IS NULL
          UNION
          SELECT activities.activity_id
          FROM projection_threads AS threads
          INNER JOIN projection_thread_activities AS activities
            ON activities.thread_id = threads.thread_id
          WHERE threads.archived_at IS NULL
            AND threads.deleted_at IS NULL
            AND activities.kind COLLATE BINARY >= 'approval.'
            AND activities.kind COLLATE BINARY < 'approval/'
          UNION
          SELECT activities.activity_id
          FROM projection_threads AS threads
          INNER JOIN projection_thread_activities AS activities
            ON activities.thread_id = threads.thread_id
          WHERE threads.archived_at IS NULL
            AND threads.deleted_at IS NULL
            AND activities.kind COLLATE BINARY >= 'user-input.'
            AND activities.kind COLLATE BINARY < 'user-input/'
        )
        SELECT
          activities.activity_id AS "activityId",
          activities.thread_id AS "threadId",
          activities.turn_id AS "turnId",
          activities.tone,
          activities.kind,
          activities.summary,
          activities.payload_json AS "payload",
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
