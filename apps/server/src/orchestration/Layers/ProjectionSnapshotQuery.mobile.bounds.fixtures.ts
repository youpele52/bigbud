import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";

const BASE_TIME = Date.UTC(2026, 8, 9);

/** A distinct, ordered ISO timestamp `offsetSeconds` after the fixture base time. */
export const at = (offsetSeconds: number) =>
  new Date(BASE_TIME + offsetSeconds * 1000).toISOString();

export const publishProjectionState = Effect.fn("publishProjectionState")(function* (
  sequence: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_state`;
  for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
    yield* sql`
      INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
      VALUES (${projector}, ${sequence}, ${at(0)})
    `;
  }
});

export const insertProject = Effect.fn("insertProject")(function* (projectId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at
    ) VALUES (
      ${projectId}, 'Mobile bounds', '/tmp/mobile-bounds',
      '{"provider":"codex","model":"gpt-5.4"}', '[]', ${at(0)}, ${at(0)}
    )
  `;
});

export const insertThread = Effect.fn("insertThread")(function* (
  projectId: string,
  threadId: string,
  latestTurnId: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json,
      branch, worktree_path, latest_turn_id, created_at, updated_at
    ) VALUES (
      ${threadId}, ${projectId}, ${threadId}, '{"provider":"codex","model":"gpt-5.4"}',
      NULL, NULL, ${latestTurnId}, ${at(0)}, ${at(0)}
    )
  `;
});

export interface MessageSeed {
  readonly text: string;
  readonly streaming?: boolean;
}

/** Inserts messages oldest first; `messages[i]` is created at `at(i + 1)`. */
export const insertMessages = Effect.fn("insertMessages")(function* (
  threadId: string,
  messages: ReadonlyArray<string | MessageSeed>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const [index, message] of messages.entries()) {
    const seed = typeof message === "string" ? { text: message } : message;
    const createdAt = at(index + 1);
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (
        ${`${threadId}-message-${index + 1}`}, ${threadId}, NULL, 'assistant', ${seed.text},
        ${seed.streaming === true ? 1 : 0}, ${createdAt}, ${createdAt}
      )
    `;
  }
});

export interface ActivitySeed {
  readonly id: string;
  readonly kind: string;
  readonly sequence: number;
  readonly turnId?: string | null;
  readonly payload?: string;
}

export const insertActivities = Effect.fn("insertActivities")(function* (
  threadId: string,
  activities: ReadonlyArray<ActivitySeed>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const activity of activities) {
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES (
        ${activity.id}, ${threadId}, ${activity.turnId ?? null}, 'info', ${activity.kind},
        ${activity.kind}, ${activity.payload ?? "{}"}, ${activity.sequence},
        ${at(activity.sequence)}
      )
    `;
  }
});

export const insertPendingApproval = Effect.fn("insertPendingApproval")(function* (
  threadId: string,
  requestId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_pending_approvals (
      request_id, thread_id, turn_id, status, created_at, resolved_at
    ) VALUES (${requestId}, ${threadId}, NULL, 'pending', ${at(1)}, NULL)
  `;
});

export const insertPendingUserInput = Effect.fn("insertPendingUserInput")(function* (
  threadId: string,
  requestId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_pending_user_inputs (
      request_id, thread_id, turn_id, status, questions_json, created_at, resolved_at
    ) VALUES (${requestId}, ${threadId}, NULL, 'pending', '[]', ${at(1)}, NULL)
  `;
});

export const insertProposedPlan = Effect.fn("insertProposedPlan")(function* (
  threadId: string,
  planId: string,
  turnId: string,
  createdOffset: number,
  planMarkdown = `# ${planId}`,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_thread_proposed_plans (
      plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at
    ) VALUES (
      ${planId}, ${threadId}, ${turnId}, ${planMarkdown}, ${at(createdOffset)},
      ${at(createdOffset)}
    )
  `;
});

export const insertCheckpointTurn = Effect.fn("insertCheckpointTurn")(function* (
  threadId: string,
  turnId: string,
  checkpointTurnCount: number,
  filesJson = "[]",
) {
  const sql = yield* SqlClient.SqlClient;
  const completedAt = at(checkpointTurnCount);
  yield* sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, state, requested_at, completed_at, checkpoint_turn_count,
      checkpoint_ref, checkpoint_status, checkpoint_files_json
    ) VALUES (
      ${threadId}, ${turnId}, 'completed', ${completedAt}, ${completedAt},
      ${checkpointTurnCount}, ${`ref-${turnId}`}, 'ready', ${filesJson}
    )
  `;
});
