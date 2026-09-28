import { IsoDateTime, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const Request = Schema.Struct({ threadId: Schema.String, limit: Schema.Number });
const Row = Schema.Struct({
  threadId: ThreadId,
  title: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  sessionStatus: Schema.NullOr(Schema.String),
  latestTurnState: Schema.NullOr(Schema.String),
  deletedAt: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});

function workflowState(row: typeof Row.Type) {
  if (row.deletedAt !== null || row.title === null) return "unavailable" as const;
  if (row.sessionStatus === "error" || row.latestTurnState === "error") return "failed" as const;
  if (
    row.sessionStatus === "running" ||
    row.sessionStatus === "starting" ||
    row.latestTurnState === "running"
  )
    return "working" as const;
  return "idle" as const;
}

export function makeReadDelegatedChildren(sql: SqlClient.SqlClient) {
  const read = SqlSchema.findAll({
    Request,
    Result: Row,
    execute: ({ threadId, limit }) => sql`
      SELECT
        d.child_thread_id AS "threadId",
        t.title,
        t.project_id AS "projectId",
        s.status AS "sessionStatus",
        turns.state AS "latestTurnState",
        t.deleted_at AS "deletedAt",
        COALESCE(t.updated_at, d.updated_at) AS "updatedAt"
      FROM thread_delegations d
      LEFT JOIN projection_threads t ON t.thread_id = d.child_thread_id
      LEFT JOIN projection_thread_sessions s ON s.thread_id = d.child_thread_id
      LEFT JOIN projection_turns turns
        ON turns.thread_id = d.child_thread_id AND turns.turn_id = t.latest_turn_id
      WHERE d.caller_thread_id = ${threadId}
      ORDER BY d.updated_at DESC, d.delegation_id ASC
      LIMIT ${limit}
    `,
  });
  return read;
}

export function normalizeDelegatedChildren(rows: ReadonlyArray<typeof Row.Type>) {
  return rows.map((row) => ({
    threadId: row.threadId,
    title: row.title ?? "Unavailable thread",
    projectId: row.projectId,
    workflowState: workflowState(row),
    updatedAt: row.updatedAt,
  }));
}
