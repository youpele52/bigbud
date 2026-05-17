import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import { BUILT_IN_CHATS_PROJECT_ID, BUILT_IN_CHATS_PROJECT_TITLE } from "@bigbud/contracts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = new Date(0).toISOString();

  yield* sql`DROP INDEX IF EXISTS idx_projection_projects_updated_at`;

  yield* sql`
    CREATE TABLE projection_projects_next (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      execution_target_id TEXT NOT NULL DEFAULT 'local',
      workspace_root TEXT,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      default_model_selection_json TEXT
    )
  `;

  yield* sql`
    INSERT INTO projection_projects_next (
      project_id,
      title,
      execution_target_id,
      workspace_root,
      scripts_json,
      created_at,
      updated_at,
      deleted_at,
      default_model_selection_json
    )
    SELECT
      project_id,
      title,
      execution_target_id,
      workspace_root,
      scripts_json,
      created_at,
      updated_at,
      deleted_at,
      default_model_selection_json
    FROM projection_projects
  `;

  yield* sql`DROP TABLE projection_projects`;
  yield* sql`ALTER TABLE projection_projects_next RENAME TO projection_projects`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_updated_at
    ON projection_projects(updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_workspace_root_deleted_at
    ON projection_projects(workspace_root, deleted_at)
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_projects (
      project_id,
      title,
      execution_target_id,
      workspace_root,
      scripts_json,
      created_at,
      updated_at,
      deleted_at,
      default_model_selection_json
    ) VALUES (
      ${BUILT_IN_CHATS_PROJECT_ID},
      ${BUILT_IN_CHATS_PROJECT_TITLE},
      'local',
      NULL,
      ${JSON.stringify([])},
      ${now},
      ${now},
      NULL,
      NULL
    )
  `;
});
