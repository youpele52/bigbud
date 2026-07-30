import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectionCatalogQuery,
  ProjectionThreadDetailNotFoundError,
} from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionCatalogQuery selected thread detail", (it) => {
  it.effect("loads bounded current detail and pages older messages by stable cursor", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      const attachments = Array.from({ length: 21 }, (_, index) => ({
        type: "file" as const,
        id: `attachment-${index}`,
        name: `attachment-${index}.txt`,
        mimeType: "text/plain",
        sizeBytes: 1,
      }));

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, latest_turn_id, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'detail-thread', 'detail-project', 'Detail', 'standard',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          'turn-current', '2026-01-01', '2026-01-04', NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, active_turn_id, updated_at
        ) VALUES ('detail-thread', 'running', 'codex', 'turn-current', '2026-01-04')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES
          ('message-a', 'detail-thread', 'assistant', 'Newest', ${JSON.stringify(attachments)}, 0, '2026-01-04', '2026-01-04'),
          ('message-b', 'detail-thread', 'user', 'Middle B', NULL, 0, '2026-01-03', '2026-01-03'),
          ('message-c', 'detail-thread', 'user', 'Middle C', NULL, 0, '2026-01-03', '2026-01-03'),
          ('message-d', 'detail-thread', 'user', 'Oldest', NULL, 0, '2026-01-02', '2026-01-02')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          ('activity-1', 'detail-thread', 'turn-current', 'tool', 'tool.started', 'One', '{}', 1, '2026-01-03'),
          ('activity-2', 'detail-thread', 'turn-current', 'tool', 'tool.completed', 'Two', '{}', 2, '2026-01-04'),
          ('activity-old', 'detail-thread', 'turn-old', 'info', 'old', 'Old', '{}', 3, '2026-01-04')
      `;
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, turn_id, status, created_at
        ) VALUES
          ('approval-1', 'detail-thread', 'turn-current', 'pending', '2026-01-03'),
          ('approval-2', 'detail-thread', 'turn-current', 'pending', '2026-01-04')
      `;
      const questions = Array.from({ length: 21 }, (_, index) => ({
        id: `question-${index}`,
        header: `Question ${index}`,
        question: `Choose ${index}`,
        options: [{ label: "Yes", description: "Continue" }],
        multiSelect: false,
      }));
      yield* sql`
        INSERT INTO projection_pending_user_inputs (
          request_id, thread_id, turn_id, status, questions_json, created_at
        ) VALUES
          ('user-input-1', 'detail-thread', 'turn-current', 'pending', ${JSON.stringify(questions)}, '2026-01-03'),
          ('user-input-2', 'detail-thread', 'turn-current', 'pending', '[]', '2026-01-04')
      `;
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, implemented_at,
          implementation_thread_id, created_at, updated_at
        ) VALUES (
          'plan-1', 'detail-thread', 'turn-current', '# Plan', NULL, NULL,
          '2026-01-03', '2026-01-04'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
        VALUES
          ('task-active', 'detail-thread', ${JSON.stringify({
            id: "task-active",
            status: "inProgress",
            subject: "Active",
            source: "lifecycle",
            freshness: { sessionEpoch: "test", sourcePriority: 1, observedOrdinal: 1 },
            createdAt: "2026-01-03",
            updatedAt: "2026-01-04",
          })}, '2026-01-03', '2026-01-04'),
          ('task-done', 'detail-thread', ${JSON.stringify({
            id: "task-done",
            status: "completed",
            subject: "Done",
            source: "lifecycle",
            freshness: { sessionEpoch: "test", sourcePriority: 1, observedOrdinal: 2 },
            createdAt: "2026-01-02",
            updatedAt: "2026-01-03",
          })}, '2026-01-02', '2026-01-03')
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json, completed_at
        ) VALUES
          ('detail-thread', 'turn-current', 'running', '2026-01-04', 2, 'refs/checkpoint/2', 'ready', '[]', '2026-01-04'),
          ('detail-thread', 'turn-old', 'completed', '2026-01-02', 1, 'refs/checkpoint/1', 'ready', '[]', '2026-01-02')
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('detail-test', 12, '2026-01-04')
      `;

      const first = yield* query.getSelectedThreadDetail({
        threadId: ThreadId.makeUnsafe("detail-thread"),
        messageLimit: 2,
        activityLimit: 1,
        approvalLimit: 1,
        userInputLimit: 1,
        taskLimit: 1,
        checkpointLimit: 1,
      });
      assert.equal(first.projectionSequence, 12);
      assert.deepEqual(
        first.messages.map((message) => message.id),
        ["message-a", "message-b"],
      );
      assert.equal(first.messages[0]?.attachments.length, 20);
      assert.equal(first.messages[0]?.attachmentsTruncated, true);
      assert.deepEqual(first.messageWindow.nextCursor, {
        createdAt: "2026-01-03",
        messageId: "message-b",
      });
      assert.deepEqual(
        first.activities.map((activity) => activity.id),
        ["activity-2"],
      );
      assert.equal(first.activitiesTruncated, true);
      assert.equal(first.pendingApprovals.length, 1);
      assert.equal(first.pendingApprovalsTruncated, true);
      assert.equal(first.pendingUserInputs.length, 1);
      assert.equal(first.pendingUserInputs[0]?.questions.length, 20);
      assert.equal(first.pendingUserInputs[0]?.questionsTruncated, true);
      assert.equal(first.pendingUserInputsTruncated, true);
      assert.equal(first.activePlan?.id, "plan-1");
      assert.deepEqual(
        first.activeTasks.map((task) => task.id),
        ["task-active"],
      );
      assert.deepEqual(
        first.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount),
        [2],
      );
      assert.equal(first.checkpointsTruncated, true);

      const second = yield* query.getSelectedThreadDetail({
        threadId: ThreadId.makeUnsafe("detail-thread"),
        messageLimit: 2,
        messageCursor: first.messageWindow.nextCursor ?? undefined,
      });
      assert.deepEqual(
        second.messages.map((message) => message.id),
        ["message-c", "message-d"],
      );
      assert.equal(second.messageWindow.hasOlder, false);
    }),
  );

  it.effect("fails explicitly when the selected thread projection is missing", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const error = yield* Effect.flip(
        query.getSelectedThreadDetail({ threadId: ThreadId.makeUnsafe("missing-thread") }),
      );
      assert.equal(error._tag, "ProjectionThreadDetailNotFoundError");
      assert.equal(ProjectionThreadDetailNotFoundError.fields.threadId !== undefined, true);
    }),
  );

  it.effect("clamps oversized message windows to the endpoint maximum", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'bounded-thread', 'detail-project', 'Bounded', 'standard',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-01-01', '2026-01-04', NULL, NULL
        )
      `;
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 201
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          printf('bounded-message-%03d', value),
          'bounded-thread',
          'user',
          printf('Message %d', value),
          0,
          printf('2026-01-%03d', value),
          printf('2026-01-%03d', value)
        FROM sequence
      `;

      const result = yield* query.getSelectedThreadDetail({
        threadId: ThreadId.makeUnsafe("bounded-thread"),
        messageLimit: 999,
      });
      assert.equal(result.messages.length, 200);
      assert.equal(result.messageWindow.hasOlder, true);
    }),
  );
});
