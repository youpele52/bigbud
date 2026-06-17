import { assert, it } from "@effect/vitest";
import { AutomationId, ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AutomationScheduleRepositoryLive } from "../Layers/AutomationScheduleRepository.ts";
import { AutomationScheduleRepository } from "../Services/AutomationScheduleRepository.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const baseLayer = Layer.mergeAll(NodeSqliteClient.layerMemory());
const repositoryLayer = AutomationScheduleRepositoryLive.pipe(Layer.provideMerge(baseLayer));
const layer = it.layer(Layer.mergeAll(baseLayer, repositoryLayer));

layer("033_AutomationSchedulesBackfillColumns", (it) => {
  it.effect("backfills legacy automation_schedules columns so project listings decode again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* AutomationScheduleRepository;

      yield* runMigrations({ toMigrationInclusive: 31 });

      yield* sql`
        CREATE TABLE automation_schedules (
          automation_id TEXT PRIMARY KEY,
          project_id TEXT,
          target_thread_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          cron_expression TEXT NOT NULL,
          timezone TEXT NOT NULL,
          next_run_at TEXT,
          paused_at TEXT,
          deleted_at TEXT,
          lease_until TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX idx_automation_schedules_due
        ON automation_schedules(next_run_at)
      `;
      yield* sql`
        CREATE INDEX idx_automation_schedules_target_thread
        ON automation_schedules(target_thread_id)
      `;
      yield* sql`
        CREATE TABLE automation_runs (
          run_id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          error_message TEXT,
          FOREIGN KEY (automation_id) REFERENCES automation_schedules(automation_id)
        )
      `;
      yield* sql`
        CREATE INDEX idx_automation_runs_automation
        ON automation_runs(automation_id, started_at)
      `;
      yield* sql`
        INSERT INTO automation_schedules (
          automation_id,
          project_id,
          target_thread_id,
          title,
          prompt,
          cron_expression,
          timezone,
          next_run_at,
          paused_at,
          deleted_at,
          lease_until,
          created_at,
          updated_at
        )
        VALUES (
          'auto-legacy-1',
          'project-legacy-1',
          'thread-legacy-1',
          'Legacy automation',
          'Run later',
          '0 * * * *',
          'UTC',
          '2026-06-16T20:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-06-16T19:00:00.000Z',
          '2026-06-16T19:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* runMigrations({ toMigrationInclusive: 33 });

      const schedules = yield* repository.listByProject({
        projectId: ProjectId.makeUnsafe("project-legacy-1"),
      });
      assert.deepStrictEqual(schedules, [
        {
          automationId: AutomationId.makeUnsafe("auto-legacy-1"),
          projectId: ProjectId.makeUnsafe("project-legacy-1"),
          targetThreadId: ThreadId.makeUnsafe("thread-legacy-1"),
          title: "Legacy automation",
          prompt: "Run later",
          scheduleKind: "custom",
          scheduleLabel: "Custom schedule",
          cronExpression: "0 * * * *",
          timezone: "UTC",
          runAt: null,
          nextRunAt: "2026-06-16T20:00:00.000Z",
          pausedAt: null,
          completedAt: null,
          deletedAt: null,
          createdAt: "2026-06-16T19:00:00.000Z",
          updatedAt: "2026-06-16T19:00:00.000Z",
        },
      ]);

      const scheduleColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(automation_schedules)
      `;
      assert.ok(scheduleColumns.some((column) => column.name === "schedule_kind"));
      assert.ok(scheduleColumns.some((column) => column.name === "schedule_label"));
      assert.ok(scheduleColumns.some((column) => column.name === "run_at"));
      assert.ok(scheduleColumns.some((column) => column.name === "completed_at"));

      const scheduleIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list('automation_schedules')
      `;
      assert.ok(
        scheduleIndexes.some((index) => index.name === "idx_automation_schedules_project_created"),
      );
    }),
  );
});
