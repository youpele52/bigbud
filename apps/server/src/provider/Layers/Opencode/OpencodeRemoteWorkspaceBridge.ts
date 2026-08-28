import { createRemoteWorkspaceMcpBridge } from "../../../remote-workspace-bridge/remoteWorkspaceMcpBridge.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import type { ThreadOrchestrationHttpConfig } from "../../../orchestration-tools/threadOrchestrationBridge.shared.ts";
import { REMOTE_WORKSPACE_MCP_SERVER_NAME } from "../../../remote-workspace-bridge/remoteWorkspaceTools.ts";

export interface OpencodeRemoteWorkspaceBridge {
  readonly cwd: string;
  readonly serverName: string;
  readonly serverPath: string;
  readonly cleanup: () => Promise<void>;
  readonly systemPrompt: string;
}

export async function createOpencodeRemoteWorkspaceBridge(
  workspaceTarget: WorkspaceTarget,
  httpConfig: ThreadOrchestrationHttpConfig,
): Promise<OpencodeRemoteWorkspaceBridge> {
  const bridge = await createRemoteWorkspaceMcpBridge(
    workspaceTarget,
    "bigbud-opencode-remote-workspace-",
    [
      "This directory is a synthetic local workspace used to run OpenCode against a remote workspace.",
      "The actual project files live on the remote host configured for this thread.",
      "",
    ],
    httpConfig,
    async () => ({ os: "linux", architecture: "unknown" }),
  );
  return {
    cwd: bridge.cwd,
    serverName: REMOTE_WORKSPACE_MCP_SERVER_NAME,
    serverPath: bridge.serverPath,
    cleanup: bridge.cleanup,
    systemPrompt: [
      "bigbud remote workspace mode is active.",
      `The actual workspace root is ${workspaceTarget.cwd ?? "the remote shell working directory"}.`,
      "The local process directory is only a synthetic bridge and is not the workspace.",
      "Use the remote read, edit, write, bash, grep, glob, and list tools for workspace operations.",
      "For file changes, prefer edit or write. apply_patch accepts only standard unified diffs, not *** Begin Patch syntax.",
    ].join(" "),
  };
}
