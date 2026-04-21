/**
 * Runtime event raw source identifiers.
 *
 * These identify the origin of provider runtime events for routing and processing.
 */
export const RUNTIME_EVENT_RAW_SOURCES = [
  "codex.app-server.notification",
  "codex.app-server.request",
  "codex.eventmsg",
  "claude.sdk.message",
  "claude.sdk.permission",
  "codex.sdk.thread-event",
  "copilot.sdk.session-event",
  "copilot.sdk.synthetic",
  "opencode.sdk.session-event",
  "opencode.sdk.synthetic",
  "pi.rpc.event",
  "pi.rpc.response",
  "pi.rpc.synthetic",
  "acp.jsonrpc",
  "acp.cursor.extension",
] as const;

/**
 * Provider session states.
 *
 * Tracks the lifecycle of a provider session from startup to termination.
 */
export const RUNTIME_SESSION_STATES = [
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
] as const;

/**
 * Thread states in the provider runtime.
 *
 * - `active`: Thread is currently executing
 * - `idle`: Thread is waiting for user input
 * - `archived`: Thread has been archived by user
 * - `closed`: Thread has been closed
 * - `compacted`: Thread has been compacted
 * - `error`: Thread encountered an error
 */
export const RUNTIME_THREAD_STATES = [
  "active",
  "idle",
  "archived",
  "closed",
  "compacted",
  "error",
] as const;

/**
 * Turn completion states.
 *
 * - `completed`: Turn finished successfully
 * - `failed`: Turn failed with an error
 * - `interrupted`: Turn was interrupted by user
 * - `cancelled`: Turn was cancelled before completion
 */
export const RUNTIME_TURN_STATES = ["completed", "failed", "interrupted", "cancelled"] as const;

/**
 * Plan step execution statuses.
 *
 * Used for tracking progress of multi-step plans.
 */
export const RUNTIME_PLAN_STEP_STATUSES = ["pending", "inProgress", "completed"] as const;

/**
 * Item execution statuses.
 *
 * Tracks the state of individual work items (tool calls, approvals, etc.).
 */
export const RUNTIME_ITEM_STATUSES = ["inProgress", "completed", "failed", "declined"] as const;

/**
 * Content stream kinds for streaming responses.
 *
 * - `assistant_text`: Regular assistant response text
 * - `reasoning_text`: Internal reasoning/thinking
 * - `reasoning_summary_text`: Summary of reasoning
 * - `plan_text`: Plan content
 * - `command_output`: Command execution output
 * - `file_change_output`: File change output
 * - `unknown`: Unknown stream kind
 */
export const RUNTIME_CONTENT_STREAM_KINDS = [
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
  "unknown",
] as const;

/**
 * Tool lifecycle item types.
 *
 * Represents different types of tool-related events in the provider runtime.
 */
export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

/**
 * Canonical item types for the conversation timeline.
 *
 * These represent the different types of items that can appear in a thread.
 */
export const CANONICAL_ITEM_TYPES = [
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  ...TOOL_LIFECYCLE_ITEM_TYPES,
  "review_entered",
  "review_exited",
  "context_compaction",
  "error",
  "unknown",
] as const;

/**
 * Canonical request types for user approvals and input.
 *
 * - `command_execution_approval`: Approve a command execution
 * - `file_read_approval`: Approve reading a file
 * - `file_change_approval`: Approve modifying a file
 * - `apply_patch_approval`: Approve applying a patch
 * - `exec_command_approval`: Approve executing a command
 * - `tool_user_input`: Tool user input request
 * - `dynamic_tool_call`: Dynamic tool call
 * - `auth_tokens_refresh`: Authentication token refresh
 * - `unknown`: Unknown request type
 */
export const CANONICAL_REQUEST_TYPES = [
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "apply_patch_approval",
  "exec_command_approval",
  "tool_user_input",
  "dynamic_tool_call",
  "auth_tokens_refresh",
  "unknown",
] as const;
