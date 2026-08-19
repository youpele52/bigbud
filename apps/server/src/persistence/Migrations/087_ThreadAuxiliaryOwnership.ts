import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    {
      table: "learning_jobs",
      columns:
        "job_id, thread_id, turn_id, provider, model, model_selection_json, state, created_at, updated_at, memory_user_message_count",
      definition: `
        job_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        model_selection_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        memory_user_message_count INTEGER,
        UNIQUE(thread_id, turn_id)
      `,
    },
    {
      table: "skill_change_proposals",
      columns:
        "proposal_id, thread_id, turn_id, provider, skill_path, original_hash, old_text, new_text, reason, status, created_at, resolved_at",
      definition: `
        proposal_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        skill_path TEXT NOT NULL,
        original_hash TEXT NOT NULL,
        old_text TEXT NOT NULL,
        new_text TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      `,
    },
  ] as const;

  for (const { table, columns, definition } of tables) {
    const artifacts = yield* sql<SchemaArtifact>`
      SELECT sql FROM sqlite_master
      WHERE tbl_name = ${table}
        AND type IN ('index', 'trigger')
        AND sql IS NOT NULL
      ORDER BY name
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
