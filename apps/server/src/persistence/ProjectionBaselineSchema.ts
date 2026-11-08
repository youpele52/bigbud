export const PROJECTION_BASELINE_TABLES = [
  "projection_projects",
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_thread_tasks",
  "projection_thread_sessions",
  "projection_turns",
  "projection_pending_approvals",
  "projection_pending_user_inputs",
  "projection_usage_contributions",
  "projection_usage_codex_state",
  "projection_usage_codex_retired_turns",
] as const;

export const PROJECTION_BASELINE_THREAD_OWNED_TABLES = [
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_thread_tasks",
  "projection_thread_sessions",
  "projection_turns",
  "projection_pending_approvals",
  "projection_pending_user_inputs",
  "projection_usage_contributions",
  "projection_usage_codex_state",
  "projection_usage_codex_retired_turns",
] as const satisfies ReadonlyArray<(typeof PROJECTION_BASELINE_TABLES)[number]>;

export const PROJECTION_BASELINE_REQUIRED_TABLES = [
  ...PROJECTION_BASELINE_TABLES,
  "projection_state",
  "projection_usage_backfill_state",
  "projection_usage_estimate_backfill_state",
  "projection_baseline_rows",
  // Disposable scan cursor: reset on restore, never a canonical timing fact.
  "projection_organization_age_backfill",
] as const;

/**
 * Tables whose primary key is an AUTOINCREMENT surrogate that baselines leave out, by column.
 *
 * `projection_turns.row_id` identifies nothing outside its own database: nothing references it
 * and no projector reads it, but its value depends on `sqlite_sequence`, which survives deleting
 * the newest row (revert, cleared pending start, thread delete). A replay workspace restored
 * from a baseline restarts the sequence at the largest restored id, so any turn inserted after
 * the baseline would get a different id there than live, and every candidate would fail
 * verification. Capture therefore drops the column, restore lets SQLite assign it, and restore
 * replaces such a table whole (it has no stable key to match rows by); the table's own UNIQUE
 * constraints still reject duplicate turns.
 */
export const PROJECTION_BASELINE_SURROGATE_KEYS: Readonly<
  Partial<Record<(typeof PROJECTION_BASELINE_TABLES)[number], string>>
> = {
  projection_turns: "row_id",
};
