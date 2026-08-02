import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "last_used_at")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN last_used_at TEXT`;
  }

  yield* sql`
    UPDATE projection_projects
    SET last_used_at = CASE
      WHEN COALESCE(
        (SELECT MAX(updated_at) FROM projection_threads WHERE project_id = projection_projects.project_id),
        updated_at
      ) > updated_at
      THEN (
        SELECT MAX(updated_at)
        FROM projection_threads
        WHERE project_id = projection_projects.project_id
      )
      ELSE updated_at
    END
    WHERE last_used_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_active_last_used
    ON projection_projects(last_used_at DESC, project_id ASC)
    WHERE deleted_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_active_project_updated
    ON projection_threads(project_id, updated_at DESC, thread_id ASC)
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `;
});
