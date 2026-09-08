export const REMOTE_WORKSPACE_MCP_SERVER_NAME = "bigbud_remote_workspace";

export const REMOTE_WORKSPACE_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "list",
  "apply_patch",
] as const;

export type RemoteWorkspaceToolName = (typeof REMOTE_WORKSPACE_TOOL_NAMES)[number];

export const remoteWorkspaceMcpToolId = (name: RemoteWorkspaceToolName): string =>
  `mcp__${REMOTE_WORKSPACE_MCP_SERVER_NAME}__${name}`;
