/**
 * Git stacked action types.
 *
 * These represent atomic or combined git operations that can be performed
 * as a single user action.
 *
 * - `commit`: Create a commit
 * - `push`: Push to remote
 * - `create_pr`: Create a pull request
 * - `commit_push`: Commit and push
 * - `commit_push_pr`: Commit, push, and create PR
 */
export const GIT_STACKED_ACTIONS = [
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
] as const;

/**
 * Phases of a git stacked action.
 *
 * Used for progress tracking and error reporting.
 */
export const GIT_ACTION_PROGRESS_PHASES = ["branch", "commit", "push", "pr"] as const;

/**
 * Git action progress event kinds.
 *
 * Represents different stages of action execution for UI feedback.
 */
export const GIT_ACTION_PROGRESS_KINDS = [
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
] as const;

/**
 * Git action output streams.
 *
 * - `stdout`: Standard output
 * - `stderr`: Standard error
 */
export const GIT_ACTION_PROGRESS_STREAMS = ["stdout", "stderr"] as const;

/**
 * Pull request states.
 *
 * - `open`: PR is open and active
 * - `closed`: PR was closed without merging
 * - `merged`: PR was merged
 */
export const GIT_PR_STATES = ["open", "closed", "merged"] as const;

/**
 * Pull request thread preparation modes.
 *
 * - `local`: Prepare PR in the main workspace
 * - `worktree`: Prepare PR in an isolated worktree
 */
export const GIT_PREPARE_PR_THREAD_MODES = ["local", "worktree"] as const;
