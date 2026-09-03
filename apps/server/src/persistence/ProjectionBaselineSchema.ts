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
] as const satisfies ReadonlyArray<(typeof PROJECTION_BASELINE_TABLES)[number]>;

export const PROJECTION_BASELINE_REQUIRED_TABLES = [
  ...PROJECTION_BASELINE_TABLES,
  "projection_state",
] as const;
