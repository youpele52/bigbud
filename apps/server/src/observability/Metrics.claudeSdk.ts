import { Metric } from "effect";

/** Claude SDK messages that bigbud observes but deliberately does not surface. */
export const claudeSdkMessagesTotal = Metric.counter("bigbud_claude_sdk_messages_total", {
  description: "Claude Agent SDK informational messages handled as no-ops, by kind.",
});

const CLAUDE_SDK_MESSAGE_KINDS = new Set([
  "thinking_tokens",
  "informational",
  "notification",
  "session_state_changed",
  "memory_recall",
  "local_command_output",
  "mirror_error",
  "prompt_suggestion",
  "plugin_install",
]);

/** Only allowlisted kinds; message content never becomes a dimension. */
export const claudeSdkMessageMetricAttributes = (kind: string) => ({
  kind: CLAUDE_SDK_MESSAGE_KINDS.has(kind) ? kind : "unknown",
});
