import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite requires a table rebuild to make physical fields nullable for create-only submissions.
  yield* sql`
    CREATE TABLE orchestration_bootstrap_recipes_v114 (
      parent_command_id TEXT PRIMARY KEY,
      recipe_version TEXT NOT NULL,
      execution_target_id TEXT,
      project_id TEXT,
      project_cwd TEXT,
      base_branch TEXT,
      requested_branch TEXT,
      deterministic_worktree_path TEXT,
      created_at TEXT NOT NULL,
      original_payload_digest_version TEXT,
      original_payload_digest TEXT
    )
  `;
  yield* sql`
    INSERT INTO orchestration_bootstrap_recipes_v114 (
      parent_command_id, recipe_version, execution_target_id, project_id,
      project_cwd, base_branch, requested_branch, deterministic_worktree_path, created_at
    )
    SELECT
      parent_command_id, recipe_version, execution_target_id, project_id,
      project_cwd, base_branch, requested_branch, deterministic_worktree_path, created_at
    FROM orchestration_bootstrap_recipes
  `;
  yield* sql`DROP TABLE orchestration_bootstrap_recipes`;
  yield* sql`
    ALTER TABLE orchestration_bootstrap_recipes_v114 RENAME TO orchestration_bootstrap_recipes
  `;
});
