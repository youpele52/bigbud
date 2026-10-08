import type { CanUseTool, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeSessionPermissionSuggestions } from "./Adapter.approval.permissions.ts";

function options(
  suggestions: PermissionUpdate[],
  suppressAlwaysAllowRule = false,
): Parameters<CanUseTool>[2] {
  return {
    suggestions,
    suppressAlwaysAllowRule,
    signal: new AbortController().signal,
    requestId: "request",
    toolUseID: "tool",
  };
}

describe("Claude session permission boundaries", () => {
  it("normalizes allow additions without mutating SDK suggestions or writing settings", () => {
    const suggestions: PermissionUpdate[] = [
      {
        type: "addRules",
        behavior: "allow",
        rules: [{ toolName: "Bash", ruleContent: "git status" }],
        destination: "localSettings",
      },
      { type: "addDirectories", directories: ["/workspace"], destination: "projectSettings" },
      {
        type: "addRules",
        behavior: "allow",
        rules: [{ toolName: "Read" }],
        destination: "userSettings",
      },
    ];
    expect(claudeSessionPermissionSuggestions(options(suggestions))).toEqual(
      suggestions.map((suggestion) => ({ ...suggestion, destination: "session" })),
    );
    expect(suggestions.map((suggestion) => suggestion.destination)).toEqual([
      "localSettings",
      "projectSettings",
      "userSettings",
    ]);
  });

  it("does not turn an approval into a mode change or remove a deny/ask rule", () => {
    const suggestions: PermissionUpdate[] = [
      { type: "setMode", mode: "bypassPermissions", destination: "session" },
      {
        type: "removeRules",
        behavior: "deny",
        rules: [{ toolName: "Bash" }],
        destination: "session",
      },
      {
        type: "replaceRules",
        behavior: "allow",
        rules: [{ toolName: "Bash" }],
        destination: "session",
      },
      { type: "addRules", behavior: "ask", rules: [{ toolName: "Bash" }], destination: "session" },
    ];
    expect(claudeSessionPermissionSuggestions(options(suggestions))).toEqual([]);
  });

  it("honors suppression and never invents broad suggestions", () => {
    expect(
      claudeSessionPermissionSuggestions(
        options(
          [
            {
              type: "addRules",
              behavior: "allow",
              rules: [{ toolName: "Bash" }],
              destination: "session",
            },
          ],
          true,
        ),
      ),
    ).toEqual([]);
    expect(claudeSessionPermissionSuggestions(options([]))).toEqual([]);
  });
});
