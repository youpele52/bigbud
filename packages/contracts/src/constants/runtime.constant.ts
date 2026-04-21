/**
 * Runtime modes control how the provider executes commands and file operations.
 *
 * - `approval-required`: User must approve all file changes and command executions
 * - `auto-accept-edits`: Provider may edit files automatically but still asks for other actions
 * - `full-access`: Provider can execute commands and modify files without approval
 */
export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "full-access"] as const;

/**
 * Default runtime mode for new threads.
 *
 * Set to `full-access` for a smoother development experience.
 * Users can change this in settings or per-thread.
 */
export const DEFAULT_RUNTIME_MODE = "full-access" as const;

/**
 * Provider interaction modes control how the assistant responds to user requests.
 *
 * - `default`: Normal conversation and code generation
 * - `plan`: Assistant creates a plan before implementing (planning mode)
 */
export const PROVIDER_INTERACTION_MODES = ["default", "plan"] as const;

/**
 * Default interaction mode for new threads.
 */
export const DEFAULT_PROVIDER_INTERACTION_MODE = "default" as const;

/**
 * Approval policies for provider actions.
 *
 * - `untrusted`: Always require approval
 * - `on-failure`: Require approval only after a failure
 * - `on-request`: Require approval when provider requests it
 * - `never`: Never require approval (dangerous)
 */
export const PROVIDER_APPROVAL_POLICIES = [
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const;

/**
 * Sandbox modes control filesystem access levels.
 *
 * - `read-only`: Provider can only read files
 * - `workspace-write`: Provider can write within workspace
 * - `danger-full-access`: Provider has full filesystem access (use with caution)
 */
export const PROVIDER_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
