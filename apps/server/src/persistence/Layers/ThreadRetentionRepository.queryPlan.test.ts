import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  retentionCandidateSelectSql,
  retentionPerThreadCandidateSelectSql,
} from "./ThreadRetentionRepository.pages.ts";

const layer = it.layer(Layer.mergeAll(SqlitePersistenceMemory));

layer("ThreadRetentionRepository query plan", (it) => {
  it.effect("uses retention and endpoint indexes at 10,000 threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, provider_runtime_execution_target_id,
          workspace_execution_target_id, execution_target_id, workspace_root,
          default_model_selection_json, scripts_json, created_at, updated_at,
          deleting_at, deleted_at
        ) VALUES ('project-scale', 'Scale', 'local', 'local', 'local', '/tmp/scale',
          NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL)
      `;
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 10000
        )
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, elevator_summary,
          elevator_summary_message_count, provider_runtime_execution_target_id,
          workspace_execution_target_id, execution_target_id, model_selection_json,
          runtime_mode, interaction_mode, queued_prompts_json, created_at, updated_at,
          last_activity_at, archived_at, pinned_at, deleting_at, deleted_at
        )
        SELECT printf('thread-%05d', value), 'project-scale', 'Scale', 'standard', 'Scale', 0,
          'local', 'local', 'local', '{"provider":"codex","model":"gpt-5.4"}',
          'full-access', 'default', '[]', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL
        FROM sequence
      `;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project-other', 'Other', '/tmp/other', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_threads
          (thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, created_at, updated_at)
        VALUES ('other-thread', 'project-other', 'Other',
          '{"provider":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, attachments_json, is_streaming,
            created_at, updated_at)
        VALUES ('other-user', 'other-thread', 'user', 'hello', '[]', 0,
          '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `;

      const plan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${retentionCandidateSelectSql}`,
        ["2026-02-01T00:00:00.000Z", null, null, null, null, 25],
      );
      const details = plan.map((row) => row.detail).join("\n");
      assert.match(details, /idx_projection_threads_retention_(scan|created)/);
      assert.include(details, "idx_automation_schedules_owned_target_thread");
      assert.include(details, "idx_thread_activity_leases_thread");
      assert.include(details, "idx_worktree_runtime_leases_thread");
      assert.notInclude(details, "SCAN lease");
      const createdPlan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${retentionPerThreadCandidateSelectSql("created")}`,
        ["2026-02-01T00:00:00.000Z", null, null, null, null, 25],
      );
      assert.include(
        createdPlan.map((row) => row.detail).join("\n"),
        "idx_projection_threads_retention_created",
      );
      const activityPlan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${retentionPerThreadCandidateSelectSql("last-conversation-activity")}`,
        ["2026-02-01T00:00:00.000Z", null, null, null, null, 25],
      );
      assert.include(
        activityPlan.map((row) => row.detail).join("\n"),
        "idx_projection_thread_messages_latest_user",
      );
      const cursorRows = yield* sql.unsafe<{ threadId: string; lastActivityAt: string }>(
        retentionPerThreadCandidateSelectSql("last-conversation-activity"),
        [
          "2026-02-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "thread-09999",
          25,
        ],
      );
      assert.deepEqual(
        cursorRows.map((row) => row.threadId),
        ["thread-10000", "other-thread"],
      );
    }),
  );
});
