import {
  createRemoteWorkspaceBridge,
  type RemoteWorkspaceBridge,
} from "../../../remote-workspace-bridge/remoteWorkspaceBridge.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import type { ThreadOrchestrationHttpConfig } from "../../../orchestration-tools/threadOrchestrationBridge.shared.ts";
import { renderOpencodeRemoteWorkspaceBridgeFiles } from "./OpencodeRemoteWorkspaceBridge.template.ts";

export interface OpencodeRemoteWorkspaceBridge {
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
  readonly systemPrompt: string;
}

async function writeBridgeFiles(
  bridge: RemoteWorkspaceBridge,
  workspaceTarget: WorkspaceTarget,
  httpConfig: ThreadOrchestrationHttpConfig,
): Promise<void> {
  const files = renderOpencodeRemoteWorkspaceBridgeFiles(httpConfig);
  await Promise.all(
    Object.entries(files).map(([relativePath, source]) =>
      bridge.writeWorkspaceFile(relativePath, source),
    ),
  );
  await bridge.writeWorkspaceFile(
    ".opencode/README.txt",
    [
      "This OpenCode project is a synthetic local workspace.",
      `Remote workspace root: ${workspaceTarget.cwd ?? "[remote shell default cwd]"}`,
      "Built-in filesystem and shell tools are overridden to operate through the bigbud remote agent.",
      "",
    ].join("\n"),
  );
}

export async function createOpencodeRemoteWorkspaceBridge(
  workspaceTarget: WorkspaceTarget,
  httpConfig: ThreadOrchestrationHttpConfig,
): Promise<OpencodeRemoteWorkspaceBridge> {
  const bridge = await createRemoteWorkspaceBridge({
    workspaceTarget,
    prefix: "bigbud-opencode-remote-workspace-",
    readmeLines: [
      "This directory is a synthetic local workspace used to run OpenCode against a remote workspace.",
      "The actual project files live on the remote host configured for this thread.",
      "",
    ],
  });
  await writeBridgeFiles(bridge, workspaceTarget, httpConfig);
  return {
    cwd: bridge.cwd,
    cleanup: () => bridge.cleanup(),
    systemPrompt: [
      "bigbud remote workspace mode is active.",
      `The actual workspace root is ${workspaceTarget.cwd ?? "the remote shell working directory"}.`,
      "The local process directory is only a synthetic bridge and is not the workspace.",
      "Use the remote read, edit, write, bash, grep, glob, and list tools for workspace operations.",
      "For file changes, prefer edit or write. apply_patch accepts only standard unified diffs, not *** Begin Patch syntax.",
    ].join(" "),
  };
}
