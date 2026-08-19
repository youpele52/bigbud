import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe("DROP INDEX IF EXISTS idx_projection_threads_retention_scan");
  yield* sql.unsafe(`
    CREATE INDEX idx_projection_threads_retention_scan
    ON projection_threads(last_activity_at ASC, thread_id ASC)
    WHERE deleted_at IS NULL
  `);
  const tables = [
    {
      table: "projection_thread_messages",
      columns:
        "message_id, thread_id, turn_id, role, text, attachments_json, reply_to_json, is_streaming, created_at, updated_at",
      definition: `
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT,
        reply_to_json TEXT,
        is_streaming INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      `,
    },
    {
      table: "projection_thread_activities",
      columns:
        "activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at",
      definition: `
        activity_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT,
        tone TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        sequence INTEGER,
        created_at TEXT NOT NULL
      `,
    },
    {
      table: "projection_thread_sessions",
      columns:
        "thread_id, status, provider_name, provider_session_id, provider_thread_id, runtime_mode, active_turn_id, reason, last_error, updated_at",
      definition: `
        thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        provider_name TEXT,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        runtime_mode TEXT,
        active_turn_id TEXT,
        reason TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      `,
    },
  ] as const;

  for (const { table, columns, definition } of tables) {
    const artifacts = yield* sql<SchemaArtifact>`
      SELECT sql FROM sqlite_master
      WHERE tbl_name = ${table} AND type IN ('index', 'trigger') AND sql IS NOT NULL
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
