import type { Tool, ToolResultObject } from "@github/copilot-sdk";

import type { AgentWorkspaceToolName } from "./AgentWorkspaceTools.ts";
import { AGENT_WORKSPACE_TOOL_SPECS } from "./AgentWorkspaceToolSpecs.ts";

const result = (type: "success" | "failure", message: string): ToolResultObject => ({
  textResultForLlm: message,
  resultType: type,
  ...(type === "failure" ? { error: message } : {}),
  sessionLog: message,
});

export function createCopilotAgentWorkspaceTools(
  execute: (
    tool: AgentWorkspaceToolName,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>,
): ReadonlyArray<Tool<Record<string, unknown>>> {
  return AGENT_WORKSPACE_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    handler: async (args) => {
      try {
        return result("success", JSON.stringify(await execute(spec.name, args), null, 2));
      } catch (error) {
        return result("failure", error instanceof Error ? error.message : "Workspace tool failed.");
      }
    },
  }));
}
