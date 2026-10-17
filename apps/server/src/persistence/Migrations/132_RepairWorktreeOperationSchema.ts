import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { rebuildTableSql } from "./MigrationTableRebuild.ts";
import { installWorktreeOperationGuards } from "./WorktreeOperationGuards.ts";

/** Repair already-applied development schemas without inferring missing filesystem identity. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(worktree_operations)`;
  for (const column of ["parent_path", "parent_device", "parent_inode"] as const) {
    if (!columns.some((entry) => entry.name === column)) {
      yield* sql.unsafe(
        `ALTER TABLE worktree_operations ADD COLUMN ${column} ${column === "parent_path" ? "TEXT" : "INTEGER"}`,
      );
    }
  }
  yield* rebuildTableSql(
    sql,
    "worktree_operations",
    (ddl) =>
      ddl.replace(
        /CHECK\s*\(\s*kind\s+IN\s*\([^)]*\)\s*\)/i,
        "CHECK(kind IN ('rename', 'delete', 'create', 'access'))",
      ),
    {
      children: [
        "worktree_operation_items",
        "worktree_provider_relocations",
        "worktree_provider_lineage",
      ],
      restoreChildObjectsAfterCopy: true,
    },
  );
  // A historical pending intent lacks proof of the parent directory's identity.
  // Preserve it and its fence for inspection; never guess identity and move files.
  yield* sql`UPDATE worktree_operations SET phase = 'recovery-required',
    error = 'Legacy worktree operation has no verified parent identity; manual inspection is required.'
    WHERE kind IN ('rename','delete','create') AND phase NOT IN ('completed','rejected')
      AND (parent_path IS NULL OR parent_device IS NULL OR parent_inode IS NULL)`;
  yield* installWorktreeOperationGuards(sql);
});
