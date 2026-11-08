/**
 * SQL behind server-side branch copies: the durable job row and bounded reads of the source's
 * projected messages in `(created_at, message_id)` order, the order the projection lists them.
 *
 * @module ThreadBranchCopy.sql
 */
import { ChatAttachment, OrchestrationMessageReply } from "@bigbud/contracts";
import { MessageOriginSegment } from "@bigbud/contracts/orchestration/orchestration.messageOrigin.ts";
import type { ThreadBranchCopyState } from "@bigbud/contracts/orchestration/orchestration.branchCopy.ts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";

export interface MessagePosition {
  readonly createdAt: string;
  readonly messageId: string;
}

export interface BranchCopyJob {
  readonly branchThreadId: string;
  readonly sourceThreadId: string;
  readonly createInputJson: string;
  readonly boundary: MessagePosition;
  readonly totalMessages: number;
  readonly copiedMessages: number;
  readonly nextBatch: number;
  readonly cursor: MessagePosition | null;
  readonly state: ThreadBranchCopyState;
  readonly error: string | null;
}

interface JobRow {
  readonly branchThreadId: string;
  readonly sourceThreadId: string;
  readonly createInputJson: string;
  readonly boundaryCreatedAt: string;
  readonly boundaryMessageId: string;
  readonly totalMessages: number;
  readonly copiedMessages: number;
  readonly nextBatch: number;
  readonly cursorCreatedAt: string | null;
  readonly cursorMessageId: string | null;
  readonly state: ThreadBranchCopyState;
  readonly error: string | null;
}

const toJob = (row: JobRow): BranchCopyJob => ({
  branchThreadId: row.branchThreadId,
  sourceThreadId: row.sourceThreadId,
  createInputJson: row.createInputJson,
  boundary: { createdAt: row.boundaryCreatedAt, messageId: row.boundaryMessageId },
  totalMessages: Number(row.totalMessages),
  copiedMessages: Number(row.copiedMessages),
  nextBatch: Number(row.nextBatch),
  cursor:
    row.cursorCreatedAt !== null && row.cursorMessageId !== null
      ? { createdAt: row.cursorCreatedAt, messageId: row.cursorMessageId }
      : null,
  state: row.state,
  error: row.error,
});

const JOB_COLUMNS = `
  branch_thread_id AS "branchThreadId", source_thread_id AS "sourceThreadId",
  create_input_json AS "createInputJson", boundary_created_at AS "boundaryCreatedAt",
  boundary_message_id AS "boundaryMessageId", total_messages AS "totalMessages",
  copied_messages AS "copiedMessages", next_batch AS "nextBatch",
  cursor_created_at AS "cursorCreatedAt", cursor_message_id AS "cursorMessageId", state, error
`;

const decodeAttachments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(ChatAttachment)),
);
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationMessageReply));
const decodeOrigins = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(MessageOriginSegment)),
);

export const makeBranchCopySql = (sql: SqlClient.SqlClient) => {
  const getJob = (branchThreadId: string) =>
    sql
      .unsafe<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM thread_branch_copies WHERE branch_thread_id = ?`,
        [branchThreadId],
      )
      .pipe(Effect.map((rows) => (rows[0] ? toJob(rows[0]) : null)));

  const listCopyingJobIds = sql<{ readonly branchThreadId: string }>`
    SELECT branch_thread_id AS "branchThreadId" FROM thread_branch_copies
    WHERE state = 'copying' ORDER BY created_at ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.branchThreadId)));

  const insertJob = (input: {
    readonly branchThreadId: string;
    readonly sourceThreadId: string;
    readonly createInputJson: string;
    readonly boundary: MessagePosition;
    readonly totalMessages: number;
    readonly now: string;
  }) => sql`
    INSERT INTO thread_branch_copies (
      branch_thread_id, source_thread_id, create_input_json, boundary_created_at,
      boundary_message_id, total_messages, state, created_at, updated_at
    ) VALUES (
      ${input.branchThreadId}, ${input.sourceThreadId}, ${input.createInputJson},
      ${input.boundary.createdAt}, ${input.boundary.messageId}, ${input.totalMessages},
      'copying', ${input.now}, ${input.now}
    )
  `;

  /** Guarded by `next_batch`, so a stale writer never moves the cursor twice. */
  const advanceJob = (input: {
    readonly branchThreadId: string;
    readonly batch: number;
    readonly cursor: MessagePosition;
    readonly copied: number;
    readonly now: string;
  }) => sql`
    UPDATE thread_branch_copies
    SET next_batch = ${input.batch + 1}, copied_messages = copied_messages + ${input.copied},
      cursor_created_at = ${input.cursor.createdAt}, cursor_message_id = ${input.cursor.messageId},
      updated_at = ${input.now}
    WHERE branch_thread_id = ${input.branchThreadId} AND next_batch = ${input.batch}
      AND state = 'copying'
  `;

  const finishJob = (input: {
    readonly branchThreadId: string;
    readonly state: "completed" | "failed";
    readonly error: string | null;
    readonly now: string;
  }) => sql`
    UPDATE thread_branch_copies
    SET state = ${input.state}, error = ${input.error}, updated_at = ${input.now}
    WHERE branch_thread_id = ${input.branchThreadId} AND state = 'copying'
  `;

  /** A live thread: projected, not deleted, not being deleted. */
  const readLiveThread = (threadId: string) =>
    sql<{ readonly projectId: string }>`
      SELECT project_id AS "projectId" FROM projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL AND deleting_at IS NULL
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  const threadExists = (threadId: string) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS "found" FROM projection_threads WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows.length > 0));

  /** The branch point: the named message, or the newest settled one when none is named. */
  const readBoundary = (sourceThreadId: string, upToMessageId: string | null) =>
    (upToMessageId === null
      ? sql<MessagePosition & { readonly isStreaming: number }>`
          SELECT created_at AS "createdAt", message_id AS "messageId", is_streaming AS "isStreaming"
          FROM projection_thread_messages
          WHERE thread_id = ${sourceThreadId} AND is_streaming = 0
          ORDER BY created_at DESC, message_id DESC LIMIT 1
        `
      : sql<MessagePosition & { readonly isStreaming: number }>`
          SELECT created_at AS "createdAt", message_id AS "messageId", is_streaming AS "isStreaming"
          FROM projection_thread_messages
          WHERE thread_id = ${sourceThreadId} AND message_id = ${upToMessageId}
        `
    ).pipe(Effect.map((rows) => rows[0] ?? null));

  const countThrough = (sourceThreadId: string, boundary: MessagePosition) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM projection_thread_messages
      WHERE thread_id = ${sourceThreadId} AND is_streaming = 0
        AND created_at <= ${boundary.createdAt}
        AND (created_at < ${boundary.createdAt} OR message_id <= ${boundary.messageId})
    `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

  /** Ids and text sizes of the next settled messages after `cursor`, through the boundary. */
  const readNextSizes = (input: {
    readonly sourceThreadId: string;
    readonly cursor: MessagePosition | null;
    readonly boundary: MessagePosition;
    readonly limit: number;
  }) => {
    const after = input.cursor ?? { createdAt: "", messageId: "" };
    return sql<MessagePosition & { readonly textLength: number }>`
      SELECT created_at AS "createdAt", message_id AS "messageId", length(text) AS "textLength"
      FROM projection_thread_messages
      WHERE thread_id = ${input.sourceThreadId} AND is_streaming = 0
        AND created_at >= ${after.createdAt} AND created_at <= ${input.boundary.createdAt}
        AND (created_at > ${after.createdAt} OR message_id > ${after.messageId})
        AND (created_at < ${input.boundary.createdAt} OR message_id <= ${input.boundary.messageId})
      ORDER BY created_at ASC, message_id ASC
      LIMIT ${input.limit}
    `;
  };

  const readMessages = (messageIds: ReadonlyArray<string>) =>
    sql<{
      readonly messageId: string;
      readonly threadId: string;
      readonly role: ProjectionThreadMessage["role"];
      readonly text: string;
      readonly attachments: string | null;
      readonly replyTo: string | null;
      readonly originSegments: string | null;
      readonly createdAt: string;
      readonly updatedAt: string;
    }>`
      SELECT message_id AS "messageId", thread_id AS "threadId", role, text,
        attachments_json AS "attachments", reply_to_json AS "replyTo",
        origin_segments_json AS "originSegments", created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE message_id IN ${sql.in(messageIds)}
      ORDER BY created_at ASC, message_id ASC
    `.pipe(
      Effect.map((rows) =>
        rows.map(
          (row): ProjectionThreadMessage => ({
            messageId: row.messageId as ProjectionThreadMessage["messageId"],
            threadId: row.threadId as ProjectionThreadMessage["threadId"],
            turnId: null,
            role: row.role,
            text: row.text,
            isStreaming: false,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            ...(row.attachments !== null
              ? { attachments: decodeAttachments(row.attachments) }
              : {}),
            ...(row.replyTo !== null ? { replyTo: decodeReply(row.replyTo) } : {}),
            ...(row.originSegments !== null
              ? { originSegments: decodeOrigins(row.originSegments) }
              : {}),
          }),
        ),
      ),
    );

  return {
    getJob,
    listCopyingJobIds,
    insertJob,
    advanceJob,
    finishJob,
    readLiveThread,
    threadExists,
    readBoundary,
    countThrough,
    readNextSizes,
    readMessages,
  };
};

export type BranchCopySql = ReturnType<typeof makeBranchCopySql>;
