import {
  THREAD_DETAIL_ACTIVITY_DEFAULT_LIMIT,
  THREAD_DETAIL_ACTIVITY_MAX_LIMIT,
  THREAD_DETAIL_APPROVAL_DEFAULT_LIMIT,
  THREAD_DETAIL_APPROVAL_MAX_LIMIT,
  THREAD_DETAIL_CHECKPOINT_DEFAULT_LIMIT,
  THREAD_DETAIL_CHECKPOINT_MAX_LIMIT,
  THREAD_DETAIL_MESSAGE_ATTACHMENT_MAX_LIMIT,
  THREAD_DETAIL_MESSAGE_DEFAULT_LIMIT,
  THREAD_DETAIL_MESSAGE_MAX_LIMIT,
  THREAD_DETAIL_TASK_DEFAULT_LIMIT,
  THREAD_DETAIL_TASK_MAX_LIMIT,
  THREAD_DETAIL_USER_INPUT_DEFAULT_LIMIT,
  THREAD_DETAIL_USER_INPUT_MAX_LIMIT,
  THREAD_DETAIL_USER_INPUT_QUESTION_MAX_LIMIT,
  type GetSelectedThreadDetailInput,
  type ThreadDetailMessage,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { compareTaskOrder } from "@bigbud/shared/providerRuntime";
import { Effect, Option, Schema } from "effect";
import { clamp } from "effect/Number";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import {
  ProjectionThreadDetailNotFoundError,
  type ProjectionCatalogQueryShape,
} from "../Services/ProjectionCatalogQuery.ts";
import {
  ThreadDetailActivityDbRow,
  ThreadDetailCheckpointDbRow,
  ThreadDetailIdentityDbRow,
  ThreadDetailMessageDbRow,
  ThreadDetailPendingApprovalDbRow,
  ThreadDetailPendingUserInputDbRow,
  ThreadDetailPlanDbRow,
  ThreadDetailTaskDbRow,
} from "./ProjectionCatalogQuery.schemas.ts";

const ThreadIdentityRequest = Schema.Struct({ threadId: Schema.String });
const ThreadPageRequest = Schema.Struct({
  threadId: Schema.String,
  limit: Schema.Number,
});
const ThreadMessagePageRequest = ThreadPageRequest.pipe(
  Schema.fieldsAssign({
    cursorCreatedAt: Schema.NullOr(Schema.String),
    cursorMessageId: Schema.NullOr(Schema.String),
  }),
);
const ThreadTurnPageRequest = ThreadPageRequest.pipe(
  Schema.fieldsAssign({ turnId: Schema.NullOr(Schema.String) }),
);

function normalizeMessage(row: ThreadDetailMessageDbRow): ThreadDetailMessage {
  const attachments = row.attachments ?? [];
  return {
    id: row.messageId,
    role: row.role,
    text: row.text,
    attachments: attachments.slice(0, THREAD_DETAIL_MESSAGE_ATTACHMENT_MAX_LIMIT),
    attachmentsTruncated: attachments.length > THREAD_DETAIL_MESSAGE_ATTACHMENT_MAX_LIMIT,
    ...(row.replyTo !== null ? { replyTo: row.replyTo } : {}),
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeActivity(row: ThreadDetailActivityDbRow): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

export function makeGetSelectedThreadDetail(
  sql: SqlClient.SqlClient,
  readProjectionSequence: () => Effect.Effect<number, ProjectionRepositoryError>,
): ProjectionCatalogQueryShape["getSelectedThreadDetail"] {
  const readIdentity = SqlSchema.findOneOption({
    Request: ThreadIdentityRequest,
    Result: ThreadDetailIdentityDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        t.project_id AS "projectId",
        COALESCE(s.active_turn_id, t.latest_turn_id) AS "activityTurnId"
      FROM projection_threads t
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      WHERE t.thread_id = ${threadId} AND t.deleted_at IS NULL
    `,
  });

  const readMessages = SqlSchema.findAll({
    Request: ThreadMessagePageRequest,
    Result: ThreadDetailMessageDbRow,
    execute: ({ threadId, limit, cursorCreatedAt, cursorMessageId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        reply_to_json AS "replyTo",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND (
          ${cursorCreatedAt} IS NULL
          OR created_at < ${cursorCreatedAt}
          OR (created_at = ${cursorCreatedAt} AND message_id > ${cursorMessageId})
        )
      ORDER BY created_at DESC, message_id ASC
      LIMIT ${limit}
    `,
  });

  const readActivities = SqlSchema.findAll({
    Request: ThreadTurnPageRequest,
    Result: ThreadDetailActivityDbRow,
    execute: ({ threadId, turnId, limit }) => sql`
      SELECT
        activity_id AS "activityId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        tone,
        kind,
        summary,
        payload_json AS "payload",
        sequence,
        created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      ORDER BY sequence DESC, created_at DESC, activity_id ASC
      LIMIT ${limit}
    `,
  });

  const readPendingApprovals = SqlSchema.findAll({
    Request: ThreadPageRequest,
    Result: ThreadDetailPendingApprovalDbRow,
    execute: ({ threadId, limit }) => sql`
      SELECT request_id AS "requestId", turn_id AS "turnId", created_at AS "createdAt"
      FROM projection_pending_approvals
      WHERE thread_id = ${threadId} AND status = 'pending'
      ORDER BY created_at ASC, request_id ASC
      LIMIT ${limit}
    `,
  });

  const readPendingUserInputs = SqlSchema.findAll({
    Request: ThreadPageRequest,
    Result: ThreadDetailPendingUserInputDbRow,
    execute: ({ threadId, limit }) => sql`
      SELECT
        request_id AS "requestId",
        turn_id AS "turnId",
        questions_json AS questions,
        created_at AS "createdAt"
      FROM projection_pending_user_inputs
      WHERE thread_id = ${threadId} AND status = 'pending'
      ORDER BY created_at ASC, request_id ASC
      LIMIT ${limit}
    `,
  });

  const readActivePlan = SqlSchema.findAll({
    Request: ThreadTurnPageRequest,
    Result: ThreadDetailPlanDbRow,
    execute: ({ threadId, turnId }) => sql`
      SELECT
        plan_id AS id,
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY CASE WHEN turn_id = ${turnId} THEN 0 ELSE 1 END, updated_at DESC, plan_id ASC
      LIMIT 1
    `,
  });

  const readActiveTasks = SqlSchema.findAll({
    Request: ThreadPageRequest,
    Result: ThreadDetailTaskDbRow,
    execute: ({ threadId, limit }) => sql`
      SELECT task_json AS task
      FROM projection_thread_tasks
      WHERE thread_id = ${threadId}
        AND json_extract(task_json, '$.status') IN ('pending', 'inProgress')
      ORDER BY created_at ASC, task_id ASC
      LIMIT ${limit}
    `,
  });

  const readCheckpoints = SqlSchema.findAll({
    Request: ThreadPageRequest,
    Result: ThreadDetailCheckpointDbRow,
    execute: ({ threadId, limit }) => sql`
      SELECT
        turn_id AS "turnId",
        checkpoint_turn_count AS "checkpointTurnCount",
        checkpoint_ref AS "checkpointRef",
        checkpoint_status AS status,
        assistant_message_id AS "assistantMessageId",
        completed_at AS "completedAt"
      FROM projection_turns
      WHERE thread_id = ${threadId} AND checkpoint_turn_count IS NOT NULL
      ORDER BY checkpoint_turn_count DESC, turn_id ASC
      LIMIT ${limit}
    `,
  });

  return (input: GetSelectedThreadDetailInput) => {
    const messageLimit = clamp(input.messageLimit ?? THREAD_DETAIL_MESSAGE_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: THREAD_DETAIL_MESSAGE_MAX_LIMIT,
    });
    const activityLimit = clamp(input.activityLimit ?? THREAD_DETAIL_ACTIVITY_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: THREAD_DETAIL_ACTIVITY_MAX_LIMIT,
    });
    const approvalLimit = clamp(input.approvalLimit ?? THREAD_DETAIL_APPROVAL_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: THREAD_DETAIL_APPROVAL_MAX_LIMIT,
    });
    const taskLimit = clamp(input.taskLimit ?? THREAD_DETAIL_TASK_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: THREAD_DETAIL_TASK_MAX_LIMIT,
    });
    const userInputLimit = clamp(input.userInputLimit ?? THREAD_DETAIL_USER_INPUT_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: THREAD_DETAIL_USER_INPUT_MAX_LIMIT,
    });
    const checkpointLimit = clamp(input.checkpointLimit ?? THREAD_DETAIL_CHECKPOINT_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: THREAD_DETAIL_CHECKPOINT_MAX_LIMIT,
    });

    return sql
      .withTransaction(
        Effect.gen(function* () {
          const identity = yield* readIdentity({ threadId: input.threadId });
          if (Option.isNone(identity)) {
            return yield* new ProjectionThreadDetailNotFoundError({ threadId: input.threadId });
          }
          const activityTurnId = identity.value.activityTurnId;
          const [projectionSequence, rows] = yield* Effect.all([
            readProjectionSequence(),
            Effect.all({
              messages: readMessages({
                threadId: input.threadId,
                limit: messageLimit + 1,
                cursorCreatedAt: input.messageCursor?.createdAt ?? null,
                cursorMessageId: input.messageCursor?.messageId ?? null,
              }),
              activities: readActivities({
                threadId: input.threadId,
                turnId: activityTurnId,
                limit: activityLimit + 1,
              }),
              pendingApprovals: readPendingApprovals({
                threadId: input.threadId,
                limit: approvalLimit + 1,
              }),
              pendingUserInputs: readPendingUserInputs({
                threadId: input.threadId,
                limit: userInputLimit + 1,
              }),
              activePlan: readActivePlan({
                threadId: input.threadId,
                turnId: activityTurnId,
                limit: 1,
              }),
              activeTasks: readActiveTasks({
                threadId: input.threadId,
                limit: taskLimit + 1,
              }),
              checkpoints: readCheckpoints({
                threadId: input.threadId,
                limit: checkpointLimit + 1,
              }),
            }),
          ]);
          const messages = rows.messages.slice(0, messageLimit).map(normalizeMessage);
          const newestMessage = messages[0];
          const oldestMessage = messages.at(-1);
          const hasOlder = rows.messages.length > messageLimit;
          const activePlan = rows.activePlan[0];

          return {
            projectionSequence,
            threadId: input.threadId,
            projectId: identity.value.projectId,
            activityTurnId,
            messages,
            messageWindow: {
              order: "newest-first" as const,
              requestedCursor: input.messageCursor ?? null,
              newestCursor: newestMessage
                ? { createdAt: newestMessage.createdAt, messageId: newestMessage.id }
                : null,
              oldestCursor: oldestMessage
                ? { createdAt: oldestMessage.createdAt, messageId: oldestMessage.id }
                : null,
              nextCursor:
                hasOlder && oldestMessage
                  ? { createdAt: oldestMessage.createdAt, messageId: oldestMessage.id }
                  : null,
              hasOlder,
            },
            activities: rows.activities.slice(0, activityLimit).map(normalizeActivity),
            activitiesTruncated: rows.activities.length > activityLimit,
            pendingApprovals: rows.pendingApprovals.slice(0, approvalLimit),
            pendingApprovalsTruncated: rows.pendingApprovals.length > approvalLimit,
            pendingUserInputs: rows.pendingUserInputs.slice(0, userInputLimit).map((row) => ({
              requestId: row.requestId,
              turnId: row.turnId,
              questions: row.questions.slice(0, THREAD_DETAIL_USER_INPUT_QUESTION_MAX_LIMIT),
              questionsTruncated:
                row.questions.length > THREAD_DETAIL_USER_INPUT_QUESTION_MAX_LIMIT,
              createdAt: row.createdAt,
            })),
            pendingUserInputsTruncated: rows.pendingUserInputs.length > userInputLimit,
            activePlan:
              activePlan !== undefined && activePlan.implementedAt === null
                ? {
                    id: activePlan.id,
                    turnId: activePlan.turnId,
                    planMarkdown: activePlan.planMarkdown,
                    implementedAt: activePlan.implementedAt,
                    implementationThreadId: activePlan.implementationThreadId,
                    createdAt: activePlan.createdAt,
                    updatedAt: activePlan.updatedAt,
                  }
                : null,
            activeTasks: rows.activeTasks
              .slice(0, taskLimit)
              .map((row) => row.task)
              .toSorted(compareTaskOrder),
            activeTasksTruncated: rows.activeTasks.length > taskLimit,
            checkpoints: rows.checkpoints.slice(0, checkpointLimit),
            checkpointsTruncated: rows.checkpoints.length > checkpointLimit,
          };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(ProjectionThreadDetailNotFoundError)(cause)
            ? cause
            : toPersistenceSqlError("ProjectionCatalogQuery.getSelectedThreadDetail")(cause),
        ),
      );
  };
}
