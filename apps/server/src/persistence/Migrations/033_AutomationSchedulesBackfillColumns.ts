import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(automation_schedules)
  `;

  if (!columns.some((column) => column.name === "schedule_kind")) {
    yield* sql`
      ALTER TABLE automation_schedules
      ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'custom'
    `;
  }

  if (!columns.some((column) => column.name === "schedule_label")) {
    yield* sql`
      ALTER TABLE automation_schedules
      ADD COLUMN schedule_label TEXT NOT NULL DEFAULT 'Custom schedule'
    `;
  }

  if (!columns.some((column) => column.name === "run_at")) {
    yield* sql`
      ALTER TABLE automation_schedules
      ADD COLUMN run_at TEXT
    `;
  }

  if (!columns.some((column) => column.name === "completed_at")) {
    yield* sql`
      ALTER TABLE automation_schedules
      ADD COLUMN completed_at TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_schedules_project_created
    ON automation_schedules(project_id, deleted_at, created_at)
  `;
});
