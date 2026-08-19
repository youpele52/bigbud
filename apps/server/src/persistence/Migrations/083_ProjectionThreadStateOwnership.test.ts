import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("083_ProjectionThreadStateOwnership", (it) => {
  it.effect("cascades owned state and preserves unrelated rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES
          ('delete-parent', 'project', 'Delete', '{}', 'full-access', 'default', 'now', 'now'),
          ('keep-parent', 'project', 'Keep', '{}', 'full-access', 'default', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO projection_thread_proposed_plans
          (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at, implemented_at, implementation_thread_id)
        VALUES ('delete-plan', 'delete-parent', NULL, 'delete', 'now', 'now', 'implemented', 'implementation-thread')
      `;
      yield* sql`
        INSERT INTO projection_thread_proposed_plans
          (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at, implemented_at, implementation_thread_id)
        VALUES ('keep-plan', 'keep-parent', NULL, 'keep', 'now', 'now', NULL, NULL),
          ('orphan-plan', 'missing-parent', NULL, 'orphan', 'now', 'now', NULL, NULL)
      `;
      yield* sql`
        INSERT INTO projection_pending_approvals
          (request_id, thread_id, turn_id, status, decision, created_at, resolved_at)
        VALUES
          ('delete-approval', 'delete-parent', NULL, 'pending', NULL, 'now', NULL),
          ('keep-approval', 'keep-parent', NULL, 'pending', NULL, 'now', NULL)
      `;
      yield* sql`
        INSERT INTO projection_pending_user_inputs
          (request_id, thread_id, turn_id, status, questions_json, created_at, resolved_at)
        VALUES
          ('delete-input', 'delete-parent', NULL, 'pending', '[]', 'now', NULL),
          ('keep-input', 'keep-parent', NULL, 'pending', '[]', 'now', NULL)
      `;
      yield* sql`
        INSERT INTO projection_usage_contributions
          (contribution_id, activity_id, thread_id, turn_id, provider, model, interaction_mode,
           occurred_at, used_tokens, input_tokens, cached_input_tokens, output_tokens,
           reasoning_output_tokens, finalized, source_sequence, updated_at)
        VALUES ('delete-usage', 'delete-activity', 'delete-parent', NULL, 'provider', 'model', 'default',
          'now', 1, 1, 0, 0, 0, 1, NULL, 'now')
      `;
      yield* sql`
        INSERT INTO projection_usage_contributions
          (contribution_id, activity_id, thread_id, turn_id, provider, model, interaction_mode,
           occurred_at, used_tokens, input_tokens, cached_input_tokens, output_tokens,
           reasoning_output_tokens, finalized, source_sequence, updated_at)
        VALUES ('keep-usage', 'keep-activity', 'keep-parent', NULL, 'provider', 'model', 'default',
          'now', 1, 1, 0, 0, 0, 1, NULL, 'now')
      `;

      yield* runMigrations();

      for (const table of [
        "projection_thread_proposed_plans",
        "projection_pending_approvals",
        "projection_pending_user_inputs",
        "projection_usage_contributions",
      ]) {
        assert.deepEqual(
          yield* sql.unsafe(
            `SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('${table}')`,
          ),
          [
            {
              table: "projection_threads",
              from: "thread_id",
              to: "thread_id",
              on_delete: "CASCADE",
            },
          ],
        );
      }

      assert.deepEqual(
        yield* sql`SELECT plan_id, implemented_at, implementation_thread_id FROM projection_thread_proposed_plans ORDER BY plan_id`,
        [
          {
            plan_id: "delete-plan",
            implemented_at: "implemented",
            implementation_thread_id: "implementation-thread",
          },
          { plan_id: "keep-plan", implemented_at: null, implementation_thread_id: null },
        ],
      );
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'delete-parent'`;
      assert.deepEqual(yield* sql`SELECT plan_id FROM projection_thread_proposed_plans`, [
        { plan_id: "keep-plan" },
      ]);
      assert.deepEqual(yield* sql`SELECT request_id FROM projection_pending_approvals`, [
        { request_id: "keep-approval" },
      ]);
      assert.deepEqual(yield* sql`SELECT request_id FROM projection_pending_user_inputs`, [
        { request_id: "keep-input" },
      ]);
      assert.deepEqual(yield* sql`SELECT contribution_id FROM projection_usage_contributions`, [
        { contribution_id: "keep-usage" },
      ]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});
