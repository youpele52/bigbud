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
] as const;
