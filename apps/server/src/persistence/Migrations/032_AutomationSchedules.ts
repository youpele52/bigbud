import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_schedules (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT,
      target_thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL DEFAULT 'custom',
      schedule_label TEXT NOT NULL DEFAULT 'Custom schedule',
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      run_at TEXT,
      next_run_at TEXT,
      paused_at TEXT,
      completed_at TEXT,
      deleted_at TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_schedules_due
    ON automation_schedules(next_run_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_schedules_target_thread
    ON automation_schedules(target_thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
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
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
    ON automation_runs(automation_id, started_at)
  `;
});
