import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";

import { createRemoteWorkspaceMcpBridge } from "../../../remote-workspace-bridge/remoteWorkspaceMcpBridge.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";

const CLAUDE_REMOTE_WORKSPACE_MCP_SERVER_NAME = "bigbud_remote_workspace";
const CLAUDE_REMOTE_WORKSPACE_BUILTIN_TOOLS = [
  "AskUserQuestion",
  "TodoWrite",
  "ExitPlanMode",
] as const;
const CLAUDE_REMOTE_WORKSPACE_ALLOWED_TOOLS = [
  `mcp__${CLAUDE_REMOTE_WORKSPACE_MCP_SERVER_NAME}__read`,
  `mcp__${CLAUDE_REMOTE_WORKSPACE_MCP_SERVER_NAME}__grep`,
  `mcp__${CLAUDE_REMOTE_WORKSPACE_MCP_SERVER_NAME}__glob`,
  `mcp__${CLAUDE_REMOTE_WORKSPACE_MCP_SERVER_NAME}__list`,
] as const;

export interface ClaudeRemoteWorkspaceBridge {
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
  readonly queryOptions: Pick<ClaudeQueryOptions, "allowedTools" | "mcpServers" | "tools">;
}

export async function createClaudeRemoteWorkspaceBridge(
  workspaceTarget: WorkspaceTarget,
): Promise<ClaudeRemoteWorkspaceBridge> {
  const bridge = await createRemoteWorkspaceMcpBridge(
    workspaceTarget,
    "bigbud-claude-remote-workspace-",
    [
      "This directory is a synthetic local workspace used to run Claude against a remote workspace.",
      "The actual project files live on the remote host configured for this thread.",
      "",
    ],
  );

  return {
    cwd: bridge.cwd,
    cleanup: bridge.cleanup,
    queryOptions: {
      tools: [...CLAUDE_REMOTE_WORKSPACE_BUILTIN_TOOLS],
      allowedTools: [...CLAUDE_REMOTE_WORKSPACE_ALLOWED_TOOLS],
      mcpServers: {
        [CLAUDE_REMOTE_WORKSPACE_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [bridge.serverPath],
        },
      },
    },
  };
}
