import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const parentThreadInsert = (threadIdExpr: string) => `
  INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode,
    interaction_mode, created_at, updated_at
  ) VALUES (
    ${threadIdExpr}, 'fixture-project', 'Fixture thread',
    '{"provider":"codex","model":"fixture"}', 'full-access', 'default',
    datetime('now'), datetime('now')
  )
`;

const childTables = [
  "provider_session_runtime",
  "worktree_runtime_leases",
  "thread_activity_leases",
  "automation_runs",
] as const;

export const installTestProjectionThreadParentTriggers = Effect.fn(
  "installTestProjectionThreadParentTriggers",
)(function* () {
  if (process.env.VITEST !== "true") return;
  const sql = yield* SqlClient.SqlClient;
  for (const table of childTables) {
    yield* sql.unsafe(`
      CREATE TRIGGER IF NOT EXISTS test_ensure_thread_${table}
      BEFORE INSERT ON ${table}
      WHEN NOT EXISTS (
        SELECT 1 FROM projection_threads WHERE thread_id = NEW.thread_id
      )
      BEGIN
        ${parentThreadInsert("NEW.thread_id")};
      END
    `);
  }
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS test_ensure_thread_automation_schedules
    BEFORE INSERT ON automation_schedules
    WHEN NOT EXISTS (
      SELECT 1 FROM projection_threads WHERE thread_id = NEW.target_thread_id
    )
    BEGIN
      ${parentThreadInsert("NEW.target_thread_id")};
    END
  `);
});
