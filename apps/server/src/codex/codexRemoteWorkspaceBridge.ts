import { createRemoteWorkspaceMcpBridge } from "../remote-workspace-bridge/remoteWorkspaceMcpBridge.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";

const CODEX_REMOTE_WORKSPACE_MCP_SERVER_NAME = "bigbud_remote_workspace";

export interface CodexRemoteWorkspaceBridge {
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
  readonly configArgs: ReadonlyArray<string>;
  readonly promptPrefix: string;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function quoteTomlStringArray(values: ReadonlyArray<string>): string {
  return `[${values.map(quoteTomlString).join(", ")}]`;
}

export async function createCodexRemoteWorkspaceBridge(
  workspaceTarget: WorkspaceTarget,
): Promise<CodexRemoteWorkspaceBridge> {
  const bridge = await createRemoteWorkspaceMcpBridge(
    workspaceTarget,
    "bigbud-codex-remote-workspace-",
    [
      "This directory is a synthetic local workspace used to run Codex against a remote workspace.",
      "The actual project files live on the remote host configured for this thread.",
      "",
    ],
  );

  return {
    cwd: bridge.cwd,
    cleanup: bridge.cleanup,
    configArgs: [
      "-c",
      "app.default_tools_enabled=false",
      "-c",
      `mcp_servers.${CODEX_REMOTE_WORKSPACE_MCP_SERVER_NAME}.command=${quoteTomlString(process.execPath)}`,
      "-c",
      `mcp_servers.${CODEX_REMOTE_WORKSPACE_MCP_SERVER_NAME}.args=${quoteTomlStringArray([bridge.serverPath])}`,
      "-c",
      `mcp_servers.${CODEX_REMOTE_WORKSPACE_MCP_SERVER_NAME}.cwd=${quoteTomlString(bridge.cwd)}`,
    ],
    promptPrefix: [
      `Bigbud remote workspace mode: the actual workspace lives on ${
        workspaceTarget.executionTargetId
      }${workspaceTarget.cwd ? ` at ${workspaceTarget.cwd}` : ""}.`,
      "Ignore the local synthetic working directory.",
      "Use the MCP remote workspace tools for file reads, edits, patching, search, and shell commands.",
      "Treat all relative paths as relative to the remote workspace root.",
      "",
    ].join("\n"),
  };
}
