import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const providerRuntimeColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!providerRuntimeColumns.some((column) => column.name === "execution_target_id")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN execution_target_id TEXT NOT NULL DEFAULT 'local'
    `;
  }

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "execution_target_id")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN execution_target_id TEXT NOT NULL DEFAULT 'local'
    `;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "execution_target_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN execution_target_id TEXT NOT NULL DEFAULT 'local'
    `;
  }
});
