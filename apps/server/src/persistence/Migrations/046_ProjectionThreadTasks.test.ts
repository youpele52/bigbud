import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_ProjectionThreadTasks", (it) => {
  it.effect("creates the durable table and backfills only task activities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'task-activity', 'thread-1', 'turn-1', 'info', 'task.updated', 'Task',
          ${JSON.stringify({
            task: {
              id: "task-1",
              status: "inProgress",
              subject: "Durable task",
              createdAt: "2026-07-25T00:00:00.000Z",
              updatedAt: "2026-07-25T00:00:01.000Z",
            },
          })},
          '2026-07-25T00:00:01.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'other-activity', 'thread-1', 'turn-1', 'info', 'runtime.note', 'Other', '{}',
          '2026-07-25T00:00:02.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 46 });
      const rows = yield* sql<{ readonly taskId: string; readonly taskJson: string }>`
        SELECT task_id AS "taskId", task_json AS "taskJson"
        FROM projection_thread_tasks
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.taskId, "task-1");
      const task = JSON.parse(rows[0]?.taskJson ?? "null") as Record<string, unknown>;
      assert.equal(task.id, "task-1");
      assert.equal(task.source, "lifecycle");
      assert.deepStrictEqual(task.freshness, {
        sessionEpoch: "legacy",
        sourcePriority: 0,
        observedOrdinal: 0,
      });
      yield* runMigrations({ toMigrationInclusive: 46 });
      const count = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_tasks
      `;
      assert.deepStrictEqual(count, [{ count: 1 }]);
    }),
  );
});
