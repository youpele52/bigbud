import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    {
      table: "provider_session_runtime",
      columns:
        "thread_id, provider_name, adapter_key, execution_target_id, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json, provider_runtime_execution_target_id, workspace_execution_target_id",
      definition: `
        thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        provider_name TEXT NOT NULL,
        adapter_key TEXT NOT NULL,
        execution_target_id TEXT NOT NULL DEFAULT 'local',
        runtime_mode TEXT NOT NULL DEFAULT 'full-access',
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resume_cursor_json TEXT,
        runtime_payload_json TEXT,
        provider_runtime_execution_target_id TEXT NOT NULL DEFAULT 'local',
        workspace_execution_target_id TEXT NOT NULL DEFAULT 'local'
      `,
    },
    {
      table: "checkpoint_diff_blobs",
      columns: "thread_id, from_turn_count, to_turn_count, diff, created_at",
      definition: `
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        from_turn_count INTEGER NOT NULL,
        to_turn_count INTEGER NOT NULL,
        diff TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (thread_id, from_turn_count, to_turn_count)
      `,
    },
  ] as const;

  for (const { table, columns, definition } of tables) {
    const artifacts = yield* sql<SchemaArtifact>`
      SELECT sql FROM sqlite_master
      WHERE tbl_name = ${table}
        AND type IN ('index', 'trigger')
        AND sql IS NOT NULL
      ORDER BY type, name
    `;
    yield* sql.unsafe(`DELETE FROM ${table} WHERE NOT EXISTS (
      SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = ${table}.thread_id
    )`);
    yield* sql.unsafe(`CREATE TABLE ${table}_next (${definition})`);
    yield* sql.unsafe(`INSERT INTO ${table}_next (${columns}) SELECT ${columns} FROM ${table}`);
    yield* sql.unsafe(`DROP TABLE ${table}`);
    yield* sql.unsafe(`ALTER TABLE ${table}_next RENAME TO ${table}`);
    for (const artifact of artifacts) {
      if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
    }
  }
});
