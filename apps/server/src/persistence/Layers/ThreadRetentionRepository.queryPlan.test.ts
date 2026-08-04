import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { retentionCandidateSelectSql } from "./ThreadRetentionRepository.pages.ts";

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

      const plan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${retentionCandidateSelectSql}`,
        ["2026-02-01T00:00:00.000Z", null, null, null, null, 25],
      );
      const details = plan.map((row) => row.detail).join("\n");
      assert.include(details, "idx_projection_threads_retention_scan");
      assert.include(details, "idx_projection_thread_watches_watched_active");
      assert.include(details, "idx_thread_delegations_active_caller");
      assert.include(details, "idx_thread_activity_leases_thread");
      assert.include(details, "idx_worktree_runtime_leases_thread");
      assert.include(details, "SEARCH watch USING");
      assert.include(details, "SEARCH delegation USING");
      assert.notInclude(details, "SCAN watch");
      assert.notInclude(details, "SCAN delegation");
      assert.notInclude(details, "SCAN lease");
    }),
  );
});
