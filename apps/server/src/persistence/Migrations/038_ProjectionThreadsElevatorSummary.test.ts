import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ProjectionThreadsElevatorSummary", (it) => {
  it.effect("adds elevator summary columns and backfills them from title", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at,
          runtime_mode,
          interaction_mode,
          model_selection_json,
          archived_at,
          parent_thread_id,
          parent_thread_title,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleting_at,
          execution_target_id,
          provider_runtime_execution_target_id,
          workspace_execution_target_id
        )
        VALUES (
          'thread-1',
          'project-1',
          'Legacy title',
          NULL,
          NULL,
          NULL,
          '2026-07-05T00:00:00.000Z',
          '2026-07-05T00:00:00.000Z',
          NULL,
          'approval-required',
          'default',
          '{"provider":"codex","model":"gpt-5-codex"}',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          NULL,
          'local',
          'local',
          'local'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "elevator_summary"));
      assert.ok(columns.some((column) => column.name === "elevator_summary_message_count"));

      const rows = yield* sql<{
        readonly title: string;
        readonly elevatorSummary: string | null;
        readonly elevatorSummaryMessageCount: number;
      }>`
        SELECT
          title,
          elevator_summary AS "elevatorSummary",
          elevator_summary_message_count AS "elevatorSummaryMessageCount"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(rows, [
        {
          title: "Legacy title",
          elevatorSummary: "Legacy title",
          elevatorSummaryMessageCount: 0,
        },
      ]);
    }),
  );
});
