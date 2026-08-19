import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identityArtifacts = yield* sql<SchemaArtifact>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'orchestration_thread_identity'
      AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `;
  yield* sql.unsafe(`DELETE FROM orchestration_thread_identity WHERE NOT EXISTS (
    SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = orchestration_thread_identity.thread_id
  )`);
  yield* sql.unsafe(`CREATE TABLE orchestration_thread_identity_next (
    thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    created_sequence INTEGER NOT NULL
  )`);
  yield* sql.unsafe(`INSERT INTO orchestration_thread_identity_next
    SELECT thread_id, project_id, created_sequence FROM orchestration_thread_identity`);
  yield* sql.unsafe("DROP TABLE orchestration_thread_identity");
  yield* sql.unsafe(
    "ALTER TABLE orchestration_thread_identity_next RENAME TO orchestration_thread_identity",
  );
  for (const artifact of identityArtifacts) {
    if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
  }
  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(automation_runs)
  `;
  const optionalRunColumns = [
    ["scheduled_for", "TEXT"],
    ["trigger_kind", "TEXT NOT NULL DEFAULT 'scheduled'"],
    ["dispatched_at", "TEXT"],
    ["provider_terminal_event_id", "TEXT"],
  ] as const;
  for (const [name, definition] of optionalRunColumns) {
    if (!runColumns.some((column) => column.name === name)) {
      yield* sql.unsafe(`ALTER TABLE automation_runs ADD COLUMN ${name} ${definition}`);
    }
  }
  const runArtifacts = yield* sql<SchemaArtifact>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'automation_runs'
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
    ORDER BY type, name
  `;
  yield* sql.unsafe(`
    CREATE TEMP TABLE automation_runs_ownership_backup AS
    SELECT run_id, automation_id, thread_id, message_id, command_id, status,
      started_at, finished_at, error_message, scheduled_for, trigger_kind,
      dispatched_at, provider_terminal_event_id
    FROM automation_runs
  `);
  yield* sql.unsafe("DROP TABLE automation_runs");
  const tables = [
    {
      table: "automation_schedules",
      columns:
        "automation_id, project_id, target_thread_id, title, prompt, schedule_kind, schedule_label, cron_expression, timezone, run_at, next_run_at, paused_at, completed_at, deleted_at, lease_until, created_at, updated_at, owns_target_thread",
      definition: `
        automation_id TEXT PRIMARY KEY,
        project_id TEXT,
        target_thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
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
        updated_at TEXT NOT NULL,
        owns_target_thread INTEGER NOT NULL DEFAULT 0 CHECK (owns_target_thread IN (0, 1))
      `,
    },
    {
      table: "automation_runs",
      columns:
        "run_id, automation_id, thread_id, message_id, command_id, status, started_at, finished_at, error_message, scheduled_for, trigger_kind, dispatched_at, provider_terminal_event_id",
      definition: `
        run_id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automation_schedules(automation_id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_message TEXT,
        scheduled_for TEXT,
        trigger_kind TEXT NOT NULL DEFAULT 'scheduled',
        dispatched_at TEXT,
        provider_terminal_event_id TEXT
      `,
    },
  ] as const;

  for (const { table, columns, definition } of tables) {
    const artifacts =
      table === "automation_runs"
        ? runArtifacts
        : yield* sql<SchemaArtifact>`
      SELECT sql FROM sqlite_master
      WHERE tbl_name = ${table}
        AND type IN ('index', 'trigger')
        AND sql IS NOT NULL
      ORDER BY type, name
    `;
    if (table === "automation_schedules") {
      yield* sql.unsafe(`DELETE FROM automation_schedules WHERE NOT EXISTS (
        SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = automation_schedules.target_thread_id
      )`);
    } else {
      yield* sql.unsafe(`DELETE FROM automation_runs_ownership_backup WHERE NOT EXISTS (
        SELECT 1 FROM automation_schedules WHERE automation_schedules.automation_id = automation_runs_ownership_backup.automation_id
      ) OR NOT EXISTS (
        SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = automation_runs_ownership_backup.thread_id
      )`);
    }
    yield* sql.unsafe(`CREATE TABLE ${table}_next (${definition})`);
    const source = table === "automation_runs" ? "automation_runs_ownership_backup" : table;
    yield* sql.unsafe(`INSERT INTO ${table}_next (${columns}) SELECT ${columns} FROM ${source}`);
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
    yield* sql.unsafe(`ALTER TABLE ${table}_next RENAME TO ${table}`);
    for (const artifact of artifacts) {
      if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
    }
  }
  yield* sql.unsafe("DROP TABLE automation_runs_ownership_backup");
});
