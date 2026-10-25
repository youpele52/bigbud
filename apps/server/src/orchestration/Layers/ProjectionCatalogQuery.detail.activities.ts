import { EventId } from "@bigbud/contracts/core/baseSchemas";
import { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { ThreadDetailActivityDbRow } from "./ProjectionCatalogQuery.schemas.ts";

export function normalizeDetailActivity(
  row: ThreadDetailActivityDbRow,
): OrchestrationThreadActivity {
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

/** Load complete prompt/response pairs for the message window, independently of work-log limits. */
export function makeThreadDetailActivityReaders(sql: SqlClient.SqlClient) {
  const readActivities = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: Schema.String,
      turnId: Schema.NullOr(Schema.String),
      limit: Schema.Number,
    }),
    Result: ThreadDetailActivityDbRow,
    execute: ({ threadId, turnId, limit }) => sql`
      SELECT activity_id AS "activityId", thread_id AS "threadId", turn_id AS "turnId",
        tone, kind, summary, payload_json AS payload, sequence, created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      ORDER BY sequence DESC, created_at DESC, activity_id ASC
      LIMIT ${limit}
    `,
  });
  const readHistoryRows = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: Schema.String,
      oldestCreatedAt: Schema.NullOr(Schema.String),
      beforeCreatedAt: Schema.NullOr(Schema.String),
    }),
    Result: ThreadDetailActivityDbRow.pipe(
      Schema.fieldsAssign({
        requestId: Schema.String,
        requestedAt: Schema.String,
        questions: Schema.fromJsonString(Schema.Array(UserInputQuestion)),
      }),
    ),
    execute: ({ threadId, oldestCreatedAt, beforeCreatedAt }) => sql`
      WITH responses AS (
        SELECT a.*, r.request_id, r.questions_json, r.created_at AS requested_at,
          ROW_NUMBER() OVER (
            PARTITION BY r.request_id ORDER BY a.sequence DESC, a.created_at DESC, a.activity_id DESC
          ) AS response_rank
        FROM projection_thread_activities a
        JOIN projection_pending_user_inputs r
          ON r.request_id = json_extract(a.payload_json, '$.requestId')
          AND r.thread_id = a.thread_id
        WHERE a.thread_id = ${threadId}
          AND r.status = 'resolved'
          AND (${oldestCreatedAt} IS NULL OR r.created_at >= ${oldestCreatedAt})
          AND (${beforeCreatedAt} IS NULL OR r.created_at <= ${beforeCreatedAt})
          AND (${oldestCreatedAt} IS NULL OR a.created_at >= ${oldestCreatedAt})
          AND (a.kind = 'provider.user-input.respond.failed' OR (
            a.kind = 'user-input.resolved'
            AND json_type(a.payload_json, '$.answers') = 'object'
            AND json_extract(a.payload_json, '$.answers') != '{}'
          ))
      )
      SELECT activity_id AS "activityId", thread_id AS "threadId", turn_id AS "turnId",
        tone, kind, summary, payload_json AS payload, sequence, created_at AS "createdAt",
        request_id AS "requestId", requested_at AS "requestedAt", questions_json AS questions
      FROM responses WHERE response_rank = 1
    `,
  });
  const readUserInputHistory = Effect.fn("readUserInputHistory")(function* (
    input: Parameters<typeof readHistoryRows>[0],
  ) {
    const rows = yield* readHistoryRows(input);
    return rows.flatMap((row): OrchestrationThreadActivity[] => [
      {
        id: EventId.makeUnsafe(`history-user-input:${row.requestId}`),
        tone: "info",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: { requestId: row.requestId, questions: row.questions },
        turnId: row.turnId,
        createdAt: row.requestedAt,
      },
      normalizeDetailActivity(row),
    ]);
  });
  return { readActivities, readUserInputHistory };
}
