import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { installWorktreeOperationGuards } from "./WorktreeOperationGuards.ts";

/** Durable reservations survive process loss; runtime leases already own spawn admission. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE worktree_operations (
    operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('rename', 'delete', 'create', 'access')),
    repository TEXT NOT NULL, cwd TEXT NOT NULL,
    source_path TEXT NOT NULL, destination_path TEXT NOT NULL,
    canonical_path TEXT NOT NULL, device INTEGER NOT NULL, inode INTEGER NOT NULL,
    parent_path TEXT, parent_device INTEGER, parent_inode INTEGER,
    branch TEXT, head TEXT,
    phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','moved','references','completed','rejected','recovery-required')),
    created_at TEXT NOT NULL, error TEXT
  )`;
  yield* sql`CREATE TABLE worktree_operation_items (
    operation_id TEXT NOT NULL REFERENCES worktree_operations(operation_id),
    thread_id TEXT NOT NULL, old_path TEXT NOT NULL, new_path TEXT NOT NULL,
    command_id TEXT NOT NULL UNIQUE, completed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(operation_id, thread_id)
  )`;
  yield* sql`CREATE INDEX worktree_operations_pending ON worktree_operations(phase, source_path)`;
  yield* sql`CREATE INDEX worktree_operations_active ON worktree_operations(repository,canonical_path) WHERE phase NOT IN ('completed','rejected')`;
  yield* installWorktreeOperationGuards(sql);
});
