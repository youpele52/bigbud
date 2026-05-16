import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const providerRuntimeColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;

  if (
    !providerRuntimeColumns.some((column) => column.name === "provider_runtime_execution_target_id")
  ) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN provider_runtime_execution_target_id TEXT NOT NULL DEFAULT 'local'
    `;
  }

  if (!providerRuntimeColumns.some((column) => column.name === "workspace_execution_target_id")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN workspace_execution_target_id TEXT NOT NULL DEFAULT 'local'
    `;
  }

  yield* sql`
    UPDATE provider_session_runtime
    SET
      provider_runtime_execution_target_id = COALESCE(
        NULLIF(provider_runtime_execution_target_id, ''),
        execution_target_id,
        'local'
      ),
      workspace_execution_target_id = COALESCE(
        NULLIF(workspace_execution_target_id, ''),
        execution_target_id,
        'local'
      )
  `;
});
