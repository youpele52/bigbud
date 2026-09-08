import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* sql<{ readonly sql: string | null }>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = 'worktree_runtime_leases'
      AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `;
  yield* sql`CREATE TABLE worktree_runtime_leases_next (
    lease_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('terminal', 'shell', 'provider')),
    canonical_path TEXT NOT NULL,
    device INTEGER NOT NULL,
    inode INTEGER NOT NULL,
    process_id INTEGER,
    acquired_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`INSERT INTO worktree_runtime_leases_next
    (lease_id, thread_id, runtime_kind, canonical_path, device, inode, process_id, acquired_at, updated_at)
    SELECT lease_id, thread_id, runtime_kind, canonical_path, device, inode, process_id, acquired_at, updated_at
    FROM worktree_runtime_leases`;
  yield* sql`DROP TABLE worktree_runtime_leases`;
  yield* sql`ALTER TABLE worktree_runtime_leases_next RENAME TO worktree_runtime_leases`;
  for (const artifact of artifacts) if (artifact.sql) yield* sql.unsafe(artifact.sql);
  yield* sql`CREATE UNIQUE INDEX idx_worktree_runtime_leases_runtime_identity
    ON worktree_runtime_leases(runtime_kind, thread_id, canonical_path)
    WHERE runtime_kind <> 'terminal'`;
});
