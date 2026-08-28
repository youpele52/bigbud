import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_bootstrap_recipes (
      parent_command_id TEXT PRIMARY KEY,
      recipe_version TEXT NOT NULL,
      execution_target_id TEXT,
      project_id TEXT,
      project_cwd TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      requested_branch TEXT,
      deterministic_worktree_path TEXT,
      created_at TEXT NOT NULL
    )
  `;
});
