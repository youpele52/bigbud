import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";

import { createRemoteWorkspaceMcpBridge } from "../../../remote-workspace-bridge/remoteWorkspaceMcpBridge.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { resolveNodeExecutable } from "../../../utils/nodeExecutable.ts";
import type { ThreadOrchestrationHttpConfig } from "../../../orchestration-tools/threadOrchestrationBridge.shared.ts";
import type { RemoteWorkspaceReadinessProbe } from "../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts";
import {
  REMOTE_WORKSPACE_MCP_SERVER_NAME,
  REMOTE_WORKSPACE_TOOL_NAMES,
  remoteWorkspaceMcpToolId,
} from "../../../remote-workspace-bridge/remoteWorkspaceTools.ts";

const CLAUDE_REMOTE_WORKSPACE_BUILTIN_TOOLS = [
  "AskUserQuestion",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TodoWrite",
  "ExitPlanMode",
] as const;
const CLAUDE_REMOTE_WORKSPACE_ALLOWED_TOOLS =
  REMOTE_WORKSPACE_TOOL_NAMES.map(remoteWorkspaceMcpToolId);

export interface ClaudeRemoteWorkspaceBridge {
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
  readonly queryOptions: Pick<ClaudeQueryOptions, "allowedTools" | "mcpServers" | "tools">;
}

export async function createClaudeRemoteWorkspaceBridge(
  workspaceTarget: WorkspaceTarget,
  httpConfig: ThreadOrchestrationHttpConfig,
  readinessProbe?: RemoteWorkspaceReadinessProbe,
): Promise<ClaudeRemoteWorkspaceBridge> {
  const bridge = await createRemoteWorkspaceMcpBridge(
    workspaceTarget,
    "bigbud-claude-remote-workspace-",
    [
      "This directory is a synthetic local workspace used to run Claude against a remote workspace.",
      "The actual project files live on the remote host configured for this thread.",
      "",
    ],
    httpConfig,
    readinessProbe,
  );

  return {
    cwd: bridge.cwd,
    cleanup: bridge.cleanup,
    queryOptions: {
      tools: [...CLAUDE_REMOTE_WORKSPACE_BUILTIN_TOOLS],
      allowedTools: [...CLAUDE_REMOTE_WORKSPACE_ALLOWED_TOOLS],
      mcpServers: {
        [REMOTE_WORKSPACE_MCP_SERVER_NAME]: {
          command: resolveNodeExecutable(),
          args: [bridge.serverPath],
        },
      },
    },
  };
}
