import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_active_local_last_used
    ON projection_projects(last_used_at DESC, project_id ASC)
    WHERE deleted_at IS NULL AND workspace_execution_target_id = 'local'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_active_remote_last_used
    ON projection_projects(last_used_at DESC, project_id ASC)
    WHERE deleted_at IS NULL AND workspace_execution_target_id <> 'local'
  `;
});
