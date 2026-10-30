import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Ìtútù organization of a thread. Defaults make every existing thread Present at revision 0
 * without a backfill; only `thread.organization-updated` and unarchive change these columns.
 */
const COLUMNS: ReadonlyArray<readonly [name: string, definition: string]> = [
  ["organization_state", "TEXT NOT NULL DEFAULT 'present'"],
  ["organization_revision", "INTEGER NOT NULL DEFAULT 0"],
  ["organization_changed_at", "TEXT"],
  ["organization_snooze_id", "TEXT"],
  ["organization_snooze_until", "TEXT"],
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));
  for (const [name, definition] of COLUMNS) {
    if (existing.has(name)) continue;
    yield* sql.unsafe(`ALTER TABLE projection_threads ADD COLUMN ${name} ${definition}`);
  }
});
