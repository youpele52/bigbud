import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(automation_runs)
  `;

  if (!runColumns.some((column) => column.name === "scheduled_for")) {
    yield* sql`
      ALTER TABLE automation_runs
      ADD COLUMN scheduled_for TEXT
    `;
  }

  if (!runColumns.some((column) => column.name === "trigger_kind")) {
    yield* sql`
      ALTER TABLE automation_runs
      ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'scheduled'
    `;
  }

  if (!runColumns.some((column) => column.name === "dispatched_at")) {
    yield* sql`
      ALTER TABLE automation_runs
      ADD COLUMN dispatched_at TEXT
    `;
  }

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_scheduled_occurrence
    ON automation_runs(automation_id, scheduled_for, trigger_kind)
    WHERE trigger_kind = 'scheduled' AND scheduled_for IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_status_started
    ON automation_runs(status, started_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_scheduled
    ON automation_runs(automation_id, scheduled_for)
  `;
});
