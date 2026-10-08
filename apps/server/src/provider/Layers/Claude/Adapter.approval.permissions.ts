import type { CanUseTool, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

/** A session choice may add scoped allowances, never change modes or remove deny rules. */
export function claudeSessionPermissionSuggestions(
  options: Parameters<CanUseTool>[2],
): PermissionUpdate[] {
  if (options.suppressAlwaysAllowRule) return [];
  return (options.suggestions ?? []).flatMap((suggestion): PermissionUpdate[] =>
    suggestion.type === "addDirectories" ||
    (suggestion.type === "addRules" && suggestion.behavior === "allow")
      ? [{ ...suggestion, destination: "session" }]
      : [],
  );
}
