import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE direct_resource_cleanup_worktrees (
      operation_id TEXT NOT NULL REFERENCES direct_resource_cleanup_plans(operation_id),
      resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 512),
      original_index INTEGER NOT NULL CHECK (original_index >= 0),
      resource_json TEXT NOT NULL CHECK (
        length(resource_json) BETWEEN 2 AND 262144 AND json_valid(resource_json)
      ),
      resource_digest TEXT NOT NULL CHECK (
        length(resource_digest) = 64 AND resource_digest NOT GLOB '*[^0-9a-f]*'
      ),
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'retry', 'completed', 'blocked')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT,
      last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 128),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
      CHECK (state = 'retry' OR next_attempt_at IS NULL),
      PRIMARY KEY (operation_id, resource_id),
      UNIQUE (operation_id, original_index)
    )
  `;
  yield* sql`
    CREATE INDEX direct_resource_cleanup_worktrees_recovery
    ON direct_resource_cleanup_worktrees(state, next_attempt_at, created_at, operation_id, original_index)
  `;
  yield* sql`
    CREATE TRIGGER direct_resource_cleanup_worktree_identity_immutable
    BEFORE UPDATE ON direct_resource_cleanup_worktrees WHEN
      OLD.operation_id IS NOT NEW.operation_id OR OLD.resource_id IS NOT NEW.resource_id OR
      OLD.original_index IS NOT NEW.original_index OR OLD.resource_json IS NOT NEW.resource_json OR
      OLD.resource_digest IS NOT NEW.resource_digest OR OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'direct cleanup worktree identity is immutable'); END
  `;
});
