/**
 * Minimal rows for the phase 2 retention tests: one local project and threads in it.
 *
 * @module threadRetention.test.helpers
 */
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const RETENTION_TEST_PROJECT_ID = "retention-test-project";

/** Clears the tables these tests seed, children first. */
export const resetRetentionTestRows = Effect.fn("resetRetentionTestRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "deferred_canonical_cleanup_retries",
    "thread_retention_runs",
    "worktree_runtime_leases",
    "thread_activity_leases",
    "learning_jobs",
    "provider_session_runtime",
    "projection_thread_tasks",
    "projection_thread_sessions",
    "projection_threads",
    "projection_projects",
  ]) {
    yield* sql.unsafe(`DELETE FROM ${table}`);
  }
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${RETENTION_TEST_PROJECT_ID}, 'Retention', '/retention', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
});

export const seedRetentionTestThread = Effect.fn("seedRetentionTestThread")(function* (
  threadId: string,
  createdAt: string,
  options: { readonly parentThreadId?: string; readonly deletedAt?: string } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, parent_thread_id, title, model_selection_json, runtime_mode,
      interaction_mode, created_at, updated_at, deleted_at)
    VALUES (${threadId}, ${RETENTION_TEST_PROJECT_ID}, ${options.parentThreadId ?? null},
      ${threadId}, '{"provider":"codex","model":"test"}', 'full-access', 'default',
      ${createdAt}, ${createdAt}, ${options.deletedAt ?? null})`;
});

/** A worktree lease row; provider leases have no PID, terminals and shells may. */
export const seedWorktreeLease = Effect.fn("seedWorktreeLease")(function* (input: {
  readonly leaseId: string;
  readonly threadId: string;
  readonly kind: "terminal" | "shell" | "provider";
  readonly expiresAt: string | null;
  readonly processId?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO worktree_runtime_leases
    (lease_id, thread_id, runtime_kind, canonical_path, device, inode, process_id,
      acquired_at, updated_at, expires_at)
    VALUES (${input.leaseId}, ${input.threadId}, ${input.kind}, '/retention/worktree', 1, 1,
      ${input.processId ?? null}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      ${input.expiresAt})`;
});

export const seedActivityLease = Effect.fn("seedActivityLease")(function* (input: {
  readonly leaseId: string;
  readonly threadId: string;
  readonly kind: "browser" | "computer-use" | "learning";
  readonly expiresAt: string | null;
  readonly acquiredAt?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO thread_activity_leases
    (lease_id, thread_id, activity_kind, acquired_at, expires_at)
    VALUES (${input.leaseId}, ${input.threadId}, ${input.kind},
      ${input.acquiredAt ?? "2026-01-01T00:00:00.000Z"}, ${input.expiresAt})`;
});
