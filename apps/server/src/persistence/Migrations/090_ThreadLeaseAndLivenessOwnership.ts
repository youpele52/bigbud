import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type SchemaArtifact = { readonly sql: string | null };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    [
      "worktree_runtime_leases",
      "lease_id, thread_id, runtime_kind, canonical_path, device, inode, process_id, acquired_at, updated_at",
      "lease_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE, runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('terminal', 'shell', 'provider')), canonical_path TEXT NOT NULL, device INTEGER NOT NULL, inode INTEGER NOT NULL, process_id INTEGER, acquired_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (runtime_kind, thread_id, canonical_path)",
    ],
    [
      "thread_activity_leases",
      "lease_id, thread_id, activity_kind, acquired_at",
      "lease_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE, activity_kind TEXT NOT NULL CHECK (activity_kind IN ('browser', 'computer-use')), acquired_at TEXT NOT NULL",
    ],
  ] as const;
  for (const [table, columns, definition] of tables) {
    const artifacts = yield* sql<SchemaArtifact>`
      SELECT sql FROM sqlite_master
      WHERE tbl_name = ${table} AND type IN ('index', 'trigger') AND sql IS NOT NULL
      ORDER BY type, name
    `;
    yield* sql.unsafe(
      `DELETE FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = ${table}.thread_id)`,
    );
    yield* sql.unsafe(`CREATE TABLE ${table}_next (${definition})`);
    yield* sql.unsafe(`INSERT INTO ${table}_next (${columns}) SELECT ${columns} FROM ${table}`);
    yield* sql.unsafe(`DROP TABLE ${table}`);
    yield* sql.unsafe(`ALTER TABLE ${table}_next RENAME TO ${table}`);
    for (const artifact of artifacts) if (artifact.sql !== null) yield* sql.unsafe(artifact.sql);
  }
});
