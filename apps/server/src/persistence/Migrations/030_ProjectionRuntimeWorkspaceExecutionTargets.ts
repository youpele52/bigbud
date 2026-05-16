import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "provider_runtime_execution_target_id")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN provider_runtime_execution_target_id TEXT NOT NULL DEFAULT 'local'
    `;
  }
  if (!projectColumns.some((column) => column.name === "workspace_execution_target_id")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN workspace_execution_target_id TEXT NOT NULL DEFAULT 'local'
    `;
  }
  yield* sql`
    UPDATE projection_projects
    SET
      provider_runtime_execution_target_id = execution_target_id,
      workspace_execution_target_id = execution_target_id
    WHERE provider_runtime_execution_target_id = 'local'
       OR workspace_execution_target_id = 'local'
  `;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "provider_runtime_execution_target_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN provider_runtime_execution_target_id TEXT NOT NULL DEFAULT 'local'
    `;
  }
  if (!threadColumns.some((column) => column.name === "workspace_execution_target_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workspace_execution_target_id TEXT NOT NULL DEFAULT 'local'
    `;
  }
  yield* sql`
    UPDATE projection_threads
    SET
      provider_runtime_execution_target_id = execution_target_id,
      workspace_execution_target_id = execution_target_id
    WHERE provider_runtime_execution_target_id = 'local'
       OR workspace_execution_target_id = 'local'
  `;
});
