import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = {
  readonly name: string;
  readonly type: "index" | "trigger";
  readonly sql: string | null;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* sql<SchemaArtifact>`
    SELECT name, type, sql FROM sqlite_master
    WHERE type IN ('index', 'trigger')
      AND (
        tbl_name = 'projection_thread_attachment_refs' OR
        name LIKE 'projection_thread_attachment_refs_%'
      )
      AND sql IS NOT NULL
    ORDER BY type, name
  `;
  for (const artifact of artifacts) {
    yield* sql.unsafe(
      `DROP ${artifact.type === "index" ? "INDEX" : "TRIGGER"} IF EXISTS ${artifact.name}`,
    );
  }
  yield* sql.unsafe(`DELETE FROM projection_thread_attachment_refs WHERE NOT EXISTS (
    SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_thread_attachment_refs.thread_id
  )`);
  yield* sql.unsafe(`
    CREATE TABLE projection_thread_attachment_refs_next (
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'activity')),
      source_id TEXT NOT NULL,
      is_unresolved INTEGER NOT NULL CHECK (is_unresolved IN (0, 1)),
      CHECK (
        (is_unresolved = 0 AND attachment_id <> '') OR
        (is_unresolved = 1 AND attachment_id = '')
      ),
      PRIMARY KEY (source_kind, source_id, attachment_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    INSERT INTO projection_thread_attachment_refs_next
      (thread_id, attachment_id, source_kind, source_id, is_unresolved)
    SELECT thread_id, attachment_id, source_kind, source_id, is_unresolved
    FROM projection_thread_attachment_refs
  `);
  yield* sql.unsafe("DROP TABLE projection_thread_attachment_refs");
  yield* sql.unsafe(
    "ALTER TABLE projection_thread_attachment_refs_next RENAME TO projection_thread_attachment_refs",
  );
  for (const artifact of artifacts) {
    if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
  }
});
