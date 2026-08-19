import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* sql<SchemaArtifact>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'orchestration_thread_identity'
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
    ORDER BY type, name
  `;
  yield* sql.unsafe(`
    CREATE TABLE orchestration_thread_identity_next (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      created_sequence INTEGER NOT NULL
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO orchestration_thread_identity_next (thread_id, project_id, created_sequence)
    SELECT thread_id, project_id, created_sequence
    FROM orchestration_thread_identity
  `);
  yield* sql`DROP TABLE orchestration_thread_identity`;
  yield* sql`ALTER TABLE orchestration_thread_identity_next RENAME TO orchestration_thread_identity`;
  for (const artifact of artifacts) {
    if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
  }
});
