import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    {
      table: "projection_thread_proposed_plans",
      columns:
        "plan_id, thread_id, turn_id, plan_markdown, implemented_at, implementation_thread_id, created_at, updated_at",
      definition: `
        plan_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT,
        plan_markdown TEXT NOT NULL,
        implemented_at TEXT,
        implementation_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      `,
    },
    {
      table: "projection_pending_approvals",
      columns: "request_id, thread_id, turn_id, status, decision, created_at, resolved_at",
      definition: `
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT,
        status TEXT NOT NULL,
        decision TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      `,
    },
    {
      table: "projection_pending_user_inputs",
      columns: "request_id, thread_id, turn_id, status, questions_json, created_at, resolved_at",
      definition: `
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT,
        status TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      `,
    },
    {
      table: "projection_usage_contributions",
      columns:
        "contribution_id, activity_id, thread_id, turn_id, provider, model, interaction_mode, occurred_at, used_tokens, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, finalized, source_sequence, updated_at",
      definition: `
        contribution_id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        interaction_mode TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        used_tokens INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_output_tokens INTEGER NOT NULL,
        finalized INTEGER NOT NULL,
        source_sequence INTEGER,
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
