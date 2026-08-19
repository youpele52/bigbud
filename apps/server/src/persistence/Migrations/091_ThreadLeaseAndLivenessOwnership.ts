import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* sql<SchemaArtifact>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'provider_turn_liveness' AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `;
  yield* sql.unsafe(
    "DELETE FROM provider_turn_liveness WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = provider_turn_liveness.thread_id)",
  );
  yield* sql.unsafe(`
    CREATE TABLE provider_turn_liveness_next (
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      turn_started_at TEXT NOT NULL,
      last_runtime_event_at TEXT,
      last_meaningful_progress_at TEXT NOT NULL,
      last_inspection_at TEXT,
      inspection_status TEXT NOT NULL,
      consecutive_inspection_failures INTEGER NOT NULL DEFAULT 0,
      terminal_at TEXT,
      PRIMARY KEY (thread_id, turn_id)
    )
  `);
  yield* sql.unsafe("INSERT INTO provider_turn_liveness_next SELECT * FROM provider_turn_liveness");
  yield* sql.unsafe("DROP TABLE provider_turn_liveness");
  yield* sql.unsafe("ALTER TABLE provider_turn_liveness_next RENAME TO provider_turn_liveness");
  for (const artifact of artifacts) if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
});
